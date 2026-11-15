import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ConfirmDialogService,
  HasUnsavedChanges,
  MasterService,
  ResolvedAddress,
  ToastService,
} from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import {
  UiAddressSearchComponent,
  UiBadgeComponent,
  UiButtonComponent,
  UiComboboxComponent,
  lookupsToOptions,
} from 'jp-shared/ui';

import { SchoolContextService } from '../../../core/school-context.service';
import {
  COMPULSORY_SCHOOL_FIELDS,
  COMPULSORY_SCHOOL_FIELD_LABELS,
  CompulsorySchoolField,
  compulsorySchoolFieldError,
} from '../../../core/school-required-fields';
import {
  SchoolBranch,
  SchoolPhoto,
  SchoolProfile,
  SchoolService,
  UpdateSchoolProfileBody,
} from '../../../core/school.service';

/** Which sections exist, in the order they are read. */
type SectionKey = 'basics' | 'about' | 'facilities' | 'gallery' | 'contact';

type SaveState = 'idle' | 'saving' | 'saved' | 'conflict';

/** One photo, plus the object URL its bytes were loaded into. */
interface GalleryItem extends SchoolPhoto {
  objectUrl: string | null;
  failed: boolean;
}

/**
 * The school's own profile — what it looks like to itself, and to a teacher.
 *
 * ----------------------------------------------------------------------------
 * SECTION-LEVEL SAVE, NOT ONE FORM
 * ----------------------------------------------------------------------------
 * Five sections, each with its own save button and its own state. A school
 * fixing its phone number should not have to scroll past its photo gallery, and
 * a long form with one button at the bottom is a long form people abandon.
 *
 * ⚠️ The SERVER's unit of update is still the whole profile row — one procedure,
 * one RowVersion. So every section save sends the complete body built from the
 * current values, and the RowVersion it read. That is deliberate: a per-section
 * endpoint would need a per-section RowVersion, and two people editing different
 * sections would then silently overwrite each other's rows anyway.
 *
 * ----------------------------------------------------------------------------
 * 🔴 ROWVERSION CONFLICTS ARE SHOWN, NEVER SWALLOWED
 * ----------------------------------------------------------------------------
 * If somebody else saved while this screen was open, the server returns
 * CONCURRENCY_CONFLICT and the section says so, with a reload button. It does
 * not retry with a fresh RowVersion — that is precisely "silently overwrite the
 * other person", wearing a helpful face (the rule 2E set for the admin queue).
 *
 * ----------------------------------------------------------------------------
 * WHAT A TEACHER SEES
 * ----------------------------------------------------------------------------
 * Some of these fields are the school's public face — about, photos, the
 * address, the website. Those are marked in the UI, because somebody writing
 * their "about" text should know who reads it. PAN, affiliation and the internal
 * contacts are never published, and are marked too, for the same reason in
 * reverse.
 */
@Component({
  selector: 'app-school-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    /*
      ⚠️ SR-6. For the one link in the pin read-out. A plain <a href> would
      reload the whole app — a hard navigation out of and back into a
      federated host — and lose every unsaved section on this page, which is
      the opposite of what a "here is where to do it" link is for.
    */
    RouterLink,
    UiAddressSearchComponent,
    UiBadgeComponent,
    UiButtonComponent,
    UiComboboxComponent,
  ],
  templateUrl: './school-profile.component.html',
  styleUrl: './school-profile.component.scss',
})
export class SchoolProfileComponent implements HasUnsavedChanges, OnDestroy {
  private readonly schools = inject(SchoolService);
  private readonly context = inject(SchoolContextService);
  private readonly masters = inject(MasterService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmDialogService);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly profile = signal<SchoolProfile | null>(null);

  /** The editable copy. Only this is bound to inputs; `profile` stays as read. */
  protected readonly draft = signal<UpdateSchoolProfileBody | null>(null);

  protected readonly saveState = signal<Record<SectionKey, SaveState>>({
    basics: 'idle',
    about: 'idle',
    facilities: 'idle',
    gallery: 'idle',
    contact: 'idle',
  });

  /** Which sections have been touched since their last successful save. */
  protected readonly dirty = signal<ReadonlySet<SectionKey>>(new Set());

  // =========================================================================
  // 🔴 SR-6: THE SIX COMPULSORY FIELDS, ON A PAGE FULL OF SCHOOLS THAT PREDATE
  //    THEM
  // =========================================================================
  /*
    School type, board, affiliation number, registration number, PAN and the
    established year became required for SR-6. Every school already in the
    database registered when four of the six were optional, so rows with blanks
    in them are ORDINARY — not corrupt, not half-saved, and not the fault of
    whoever opens this page.

    ------------------------------------------------------------------------
    🔴 THE RULE, IN ONE SENTENCE
    ------------------------------------------------------------------------
    One of the six is validated ONLY IF the value on screen differs from the one
    the page loaded — so a blank left blank saves, and a field somebody touches
    has to come out valid and non-empty.

    ------------------------------------------------------------------------
    AND WHY IT IS THAT, RATHER THAN "VALIDATE THE SIX ON EVERY SAVE"
    ------------------------------------------------------------------------
    Somebody opened this page to change a phone number. Refusing that save over
    a PAN nobody asked them for — on a row that has been fine for a year — is
    the product telling a school its own data is wrong at the exact moment it
    was trying to help. They do not fix the PAN; they stop editing the profile.

    🔴 SO THE PAGE PROMPTS, IT DOES NOT REFUSE (2.62's "say why, show the
    road"). A quiet banner at the top of Basic details names what is still
    missing and why we want it, the boxes are right underneath it, and nothing
    on the page is disabled and nothing is painted red. "Not yet", never "not
    allowed".

    ⚠️ ENFORCEMENT STARTS AT THE EDIT, which is the one moment when a message is
    about something the person just did. Clearing a PAN that WAS filled in
    counts as an edit, and is refused — removing a fact is not the same as never
    having given it.

    ⚠️ THE CHECK RUNS ON EVERY SECTION'S SAVE, not just this section's, because
    `saveSection` sends the WHOLE row whichever button was pressed (see its
    note). An edited-and-broken PAN would otherwise travel out under the
    "Save contact details" button and be refused by the server with a message
    pointing at a card the person was not looking at.
  */
  protected readonly basicsErrors = signal<Partial<Record<CompulsorySchoolField, string>>>({});

  /**
   * The ones that are still blank — for the prompt, not for a refusal.
   *
   * ⚠️ BLANK ONLY, NOT "INVALID". A malformed value is reported under its own
   * box by `basicsErrors`; listing it up here as well would say the same thing
   * twice in two different voices, and the banner is about what is MISSING.
   */
  protected readonly missingCompulsory = computed(() =>
    COMPULSORY_SCHOOL_FIELDS.filter((field) => this.isBlank(field)).map(
      (field) => COMPULSORY_SCHOOL_FIELD_LABELS[field],
    ),
  );

  // ---- masters ------------------------------------------------------------
  protected readonly boards = signal<Lookup[]>([]);
  protected readonly schoolTypes = signal<Lookup[]>([]);
  protected readonly facilities = signal<Lookup[]>([]);
  protected readonly states = signal<Lookup[]>([]);
  protected readonly districts = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);
  protected readonly tehsils = signal<Lookup[]>([]);

  /**
   * 🔴 Whether the district and city datasets exist at all.
   *
   * They do not yet (2.47), and this form degrades exactly as the registration
   * form does — the controls are HIDDEN and one line says why. Not a spinner
   * that never resolves, not an empty dropdown: both read as "this form is
   * broken", and this is the same handling rather than a second one.
   */
  protected readonly hasDistricts = computed(() => this.districts().length > 0);
  protected readonly hasCities = computed(() => this.cities().length > 0);

  // A state with no tehsils in the master hides the control, exactly as the
  // district and town boxes already do. Today that means Haryana shows it.
  protected readonly hasTehsils = computed(() => this.tehsils().length > 0);

  /*
    SR-3 (G27). The three geography masters as combobox options.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE. `lookupsToOptions(states())`
    written in the binding rebuilds the array on every change-detection pass and
    hands <ui-combobox> a new `options` identity each time — which defeats the
    OnPush it was given. A computed changes identity only when the master behind
    it actually changes.
  */
  protected readonly stateOptions = computed(() => lookupsToOptions(this.states()));
  protected readonly districtOptions = computed(() => lookupsToOptions(this.districts()));
  protected readonly cityOptions = computed(() => lookupsToOptions(this.cities()));
  protected readonly tehsilOptions = computed(() => lookupsToOptions(this.tehsils()));

  /*
    P1 (G27). The two basics masters, now comboboxes like everything else.

    ⚠️ COMPUTED FOR THE SAME REASON AS THE GEOGRAPHY THREE even though neither
    ever cascades: the new-array-identity trap is a property of the binding, not
    of the master behind it.
  */
  protected readonly boardOptions = computed(() => lookupsToOptions(this.boards()));
  protected readonly schoolTypeOptions = computed(() => lookupsToOptions(this.schoolTypes()));

  // ---- facilities ---------------------------------------------------------
  protected readonly selectedFacilities = signal<ReadonlySet<number>>(new Set());

  // ---- gallery ------------------------------------------------------------
  protected readonly gallery = signal<GalleryItem[]>([]);
  protected readonly uploading = signal(false);
  protected readonly captionDrafts = signal<Record<number, string>>({});

  protected readonly groupTypes = [
    { value: 1, label: 'One campus' },
    { value: 2, label: 'Several campuses' },
  ];

  protected readonly isMultiCampus = this.context.isMultiCampus;

  constructor() {
    for (const [key, target] of [
      [MASTER_KEYS.board, this.boards],
      [MASTER_KEYS.schoolType, this.schoolTypes],
      [MASTER_KEYS.facility, this.facilities],
      [MASTER_KEYS.state, this.states],
    ] as const) {
      this.masters.get(key).subscribe({
        next: (items) => target.set(items),
        error: () => target.set([]),
      });
    }

    this.load();
  }

  ngOnDestroy(): void {
    // Blobs outlive the component otherwise, and a gallery of twenty photos
    // browsed a few times is real memory held for the life of the tab.
    this.releaseGallery();
  }

  // =========================================================================
  // LOADING
  // =========================================================================

  protected load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);

    this.schools.getProfile().subscribe({
      next: (profile) => {
        this.apply(profile);
        this.loading.set(false);
      },
      error: () => {
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });
  }

  private apply(profile: SchoolProfile): void {
    this.profile.set(profile);

    // Shared with the guard and the menu, so one read serves the whole app.
    this.context.set(profile);

    this.draft.set({
      rowVersion: profile.rowVersion,
      schoolTypeId: profile.schoolTypeId,
      boardId: profile.boardId,
      affiliationNumber: profile.affiliationNumber,
      registrationNo: profile.registrationNo,
      panNumber: profile.panNumber,
      groupType: profile.groupType,
      establishedYear: profile.establishedYear,
      aboutSchool: profile.aboutSchool,
      website: profile.website,
      contactEmail: profile.contactEmail,
      contactMobile: profile.contactMobile,
      principalName: profile.principalName,
      hrContactName: profile.hrContactName,
      hrContactMobile: profile.hrContactMobile,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      cityId: profile.cityId,
      districtId: profile.districtId,
      stateId: profile.stateId,
      pincode: profile.pincode,
      tehsilId: profile.tehsilId,
      areaOrVillage: profile.areaOrVillage,
    });

    this.selectedFacilities.set(new Set(profile.facilityIds));
    this.dirty.set(new Set());

    /*
      ⚠️ SR-6. Cleared with the draft, because every message in it was about a
      value that has just been replaced by the server's. This also runs on the
      conflict reload, where keeping them would mean complaining about somebody
      else's row.
    */
    this.basicsErrors.set({});

    this.loadGallery(profile.photos);

    /*
      🔴 BOTH DEPENDENT LISTS, OR THE SAVED TOWN IS INVISIBLE.

      Only the districts were fetched here, and the town control renders behind
      `hasCities()` — so a school whose address HAS a town opened this page with
      no town control at all. The id sat in the draft, unreadable and
      unchangeable, until the user re-picked their district to trigger the
      cascade; and `onDistrictChange` clears the town when they do, so the only
      way to see what was already saved was to lose it.

      The campus dialog hit exactly this and fixed it in `openEdit`
      (branches.component.ts); the profile was missed. Same fix, same reason.

      ⚠️ THE DISTRICT ID IS ALREADY IN HAND, so the two fetches do not have to
      be chained — nothing here waits for the district list to arrive.

      ⚠️ THROUGH loadDistricts / loadCities, NOT onStateChange /
      onDistrictChange. Those two also CLEAR the level below them, which is
      right when a person changes a parent and wrong when we are restoring what
      they saved.
    */
    if (profile.stateId) {
      this.loadDistricts(profile.stateId);
    }

    if (profile.districtId) {
      this.loadCities(profile.districtId);
    }

    /*
      ⚠️ THE TEHSIL LIST TOO, keyed on the TOWN. Same reason the town list is
      fetched here: the saved id is already in the draft, and a combobox with
      no options renders blank for a value it holds. A school that opened this
      page with a stored tehsil and no list would read as though we had lost it.
    */
    if (profile.cityId) {
      this.loadTehsils(profile.cityId);
    }
  }

  /**
   * A place picked in the search box, applied to this form.
   *
   * ----------------------------------------------------------------------------
   * 🔴 THE SAME SEQUENCING AS `apply()` ABOVE, AND FOR THE SAME REASON
   * ----------------------------------------------------------------------------
   * The ids are written first and the dependent lists are fetched from them —
   * through `loadDistricts` / `loadCities`, NEVER `onStateChange` /
   * `onDistrictChange`, because those two also clear the level below and would
   * wipe the district and town this resolve just produced. Both fetches are
   * issued together: every parent id is already in hand, so chaining them
   * would add a round trip for information we have.
   *
   * ⚠️ THE GEOGRAPHY IDS ARE REPLACED AS A SET, nulls included. They describe
   * one place — a district left over from the previous state is a value nobody
   * chose, and it would make the control's "we could not find that district"
   * line untrue.
   *
   * ⚠️ WHAT THIS FORM CANNOT KEEP IS NOT WRITTEN. `UpdateSchoolProfileBody`
   * carries no tehsil, village, coordinates or place id — 036 added those
   * columns to `t_app_schools` and nothing reads or writes them from here — so
   * they are dropped rather than set on a draft `save()` cannot send. A field
   * the server ignores is a field somebody will one day expect it to honour.
   */
  protected onAddressResolved(address: ResolvedAddress): void {
    this.set('stateId', address.stateId, 'contact');
    this.set('districtId', address.districtId, 'contact');
    this.set('cityId', address.cityId, 'contact');

    /*
      🔴 THE TEHSIL AND THE AREA ARE KEPT NOW — 15 Nov 2026.

      `ResolvedAddress` has carried both since SR-1 and this handler dropped
      them, because `USP_UpdateSchoolProfile` had no parameters to send them to.
      The comment above this method still describes that trade: "they are
      dropped rather than set on a draft `save()` cannot send. A field the
      server ignores is a field somebody will one day expect it to honour."

      The server takes them now, so dropping them would be the thing that lies.
    */
    this.set('tehsilId', address.tehsilId, 'contact');

    if (address.pincode) {
      this.set('pincode', address.pincode, 'contact');
    }

    // The user's own words are never overwritten; an empty line is filled.
    if (address.addressLine1 && !this.value('addressLine1')) {
      this.set('addressLine1', address.addressLine1, 'contact');
    }

    if (address.areaOrVillage && !this.value('areaOrVillage')) {
      this.set('areaOrVillage', address.areaOrVillage, 'contact');
    }

    this.districts.set([]);
    this.cities.set([]);
    this.tehsils.set([]);

    if (address.stateId) {
      this.loadDistricts(address.stateId);
    }

    if (address.districtId) {
      this.loadCities(address.districtId);
    }

    if (address.cityId) {
      this.loadTehsils(address.cityId);
    }
  }

  // =========================================================================
  // THE DRAFT
  // =========================================================================

  protected value<K extends keyof UpdateSchoolProfileBody>(field: K): UpdateSchoolProfileBody[K] | null {
    return this.draft()?.[field] ?? null;
  }

  protected set<K extends keyof UpdateSchoolProfileBody>(
    field: K,
    value: UpdateSchoolProfileBody[K],
    section: SectionKey,
  ): void {
    this.draft.update((draft) => (draft === null ? draft : { ...draft, [field]: value }));
    this.markDirty(section);

    /*
      SR-6. The message goes as they fix it, rather than waiting for the next
      save attempt. An error still showing after it has been fixed teaches
      people to ignore errors — the registration form clears them the same way.
    */
    if (this.basicsErrors()[field as CompulsorySchoolField] !== undefined) {
      this.basicsErrors.update((errors) => {
        const next = { ...errors };
        delete next[field as CompulsorySchoolField];

        return next;
      });
    }
  }

  private markDirty(section: SectionKey): void {
    this.dirty.update((current) => {
      if (current.has(section)) return current;

      const next = new Set(current);
      next.add(section);

      return next;
    });

    // A section that was showing "Saved" is no longer saved.
    this.saveState.update((state) =>
      state[section] === 'saved' ? { ...state, [section]: 'idle' } : state,
    );
  }

  protected isDirty(section: SectionKey): boolean {
    return this.dirty().has(section);
  }

  protected stateOf(section: SectionKey): SaveState {
    return this.saveState()[section];
  }

  // =========================================================================
  // SR-6 — THE SIX COMPULSORY FIELDS
  // =========================================================================

  /**
   * PAN, stored as the box already LOOKS.
   *
   * ⚠️ The input's `text-transform: uppercase` is paint: it changes the glyphs
   * and not the value, so `abcde1234f` looked like ABCDE1234F and was saved
   * lower case. Harmless while nothing tested it; now that both this screen and
   * the server test ^[A-Z]{5}[0-9]{4}[A-Z]$ it is a refusal over a difference
   * the school was never shown. The registration form does the same thing for
   * the same reason.
   */
  protected setPan(value: string | null): void {
    this.set('panNumber', value === null ? null : value.toUpperCase(), 'basics');
  }

  protected compulsoryError(field: CompulsorySchoolField): string | undefined {
    return this.basicsErrors()[field];
  }

  private isBlank(field: CompulsorySchoolField): boolean {
    const value = this.value(field);

    return value === null || value === undefined || String(value).trim().length === 0;
  }

  /**
   * Whether what is on screen differs from what the page loaded.
   *
   * 🔴 THE BASELINE IS `profile()`, THE LAST THING THE SERVER SAID — not a
   * snapshot taken in `apply()`. `applyAfterSave` re-reads the row after every
   * successful save and writes it there, so a value the school has just saved
   * becomes the new baseline and stops being "edited". That is what keeps the
   * next unrelated save from being refused over a field that is now stored.
   *
   * ⚠️ TRIMMED, BUT NOT CASE-FOLDED. A string that differs only in surrounding
   * space is not an edit — nobody meant it and nothing changed. A string that
   * differs in case was typed differently on purpose, and `setPan` makes PAN's
   * case stable anyway.
   */
  private isEdited(field: CompulsorySchoolField): boolean {
    const saved = this.profile()?.[field] ?? null;
    const current = this.value(field) ?? null;

    return normaliseForComparison(saved) !== normaliseForComparison(current);
  }

  /**
   * 🔴 VALIDATES ONLY WHAT THEY CHANGED. The whole rule is in `isEdited`; this
   * is the loop around it.
   *
   * Returns true when the save may go ahead.
   *
   * ⚠️ IT IS NOT THE ENFORCEMENT. `USP_UpdateSchoolProfile` refuses these six
   * independently and is what actually holds; this exists so the refusal arrives
   * before the round trip, beside the box, in a sentence written for a person.
   * If they ever disagree the server wins.
   */
  private validateCompulsory(): boolean {
    const errors: Partial<Record<CompulsorySchoolField, string>> = {};

    for (const field of COMPULSORY_SCHOOL_FIELDS) {
      if (!this.isEdited(field)) continue;

      const message = compulsorySchoolFieldError(field, this.value(field));

      if (message !== null) {
        errors[field] = message;
      }
    }

    this.basicsErrors.set(errors);

    return Object.keys(errors).length === 0;
  }

  // =========================================================================
  // SR-6 — THE MAP PIN, WHICH THIS PAGE CAN READ AND CANNOT WRITE
  // =========================================================================
  /**
   * The head office campus's saved coordinates, or null.
   *
   * ----------------------------------------------------------------------------
   * 🔴 WHY THIS IS A READ-OUT AND NOT TWO INPUT BOXES
   * ----------------------------------------------------------------------------
   * `UpdateSchoolProfileBody` carries no latitude or longitude, and neither does
   * `SchoolProfile` — the COLUMNS are on t_app_schools
   * (036_alter_address_columns.sql) and approval fills them in from the
   * registration, but this contract neither reads nor writes them. Exactly the
   * gap the tehsil and village boxes have on this page, and the same answer:
   *
   *   🔴 A BOX WHOSE VALUE IS DROPPED ON SAVE IS WORSE THAN NO BOX. The school
   *   would nudge its coordinates, press Save, be told "Saved", and nothing
   *   would have changed. A field the server ignores is a field somebody will
   *   one day expect it to honour.
   *
   * So what is drawn is what can be stated truthfully: the pin on the HEAD
   * OFFICE CAMPUS, which `SchoolProfile.branches` does carry and which the
   * campus form can genuinely edit (`SaveBranchBody` has both fields).
   *
   * ⚠️ IT IS A DIFFERENT ROW FROM THE SCHOOL'S OWN COORDINATES, and the template
   * says so rather than implying the two are one number. For a single-campus
   * school it is nevertheless THE pin a teacher's "jobs near me" will use.
   *
   * ⚠️ AND A SINGLE-CAMPUS SCHOOL CANNOT REACH THE CAMPUS FORM AT ALL
   * (singleCampusGuard, 2.10), so the copy does not send them to a screen that
   * will bounce them back here. See the note in the template.
   */
  protected readonly headOfficePin = computed<{ name: string; coordinates: string } | null>(() => {
    /*
      ⚠️ `branches?.` RATHER THAN `branches.`, EVEN THOUGH THE TYPE SAYS IT IS
      ALWAYS AN ARRAY. This runs inside a computed the template reads on every
      pass, so a projection that one day omits the list would not produce an
      empty read-out — it would throw while rendering and take the whole profile
      page down, over a line of copy about coordinates.
    */
    const branch: SchoolBranch | null = this.profile()?.branches?.find((b) => b.isHeadOffice) ?? null;

    if (branch === null || branch.latitude === null || branch.longitude === null) {
      return null;
    }

    /*
      ⚠️ SIX DECIMAL PLACES, FORMATTED HERE RATHER THAN IN THE TEMPLATE. Six is
      about ten centimetres and is the precision the campus form accepts, so the
      read-out and the editable boxes agree on what a coordinate looks like.
      Doing it in the binding would mean `pin.latitude.toFixed(6)` on a
      `number | null`, which strictTemplates refuses — correctly.
    */
    return {
      name: branch.branchName,
      coordinates: `${branch.latitude.toFixed(6)}, ${branch.longitude.toFixed(6)}`,
    };
  });

  // =========================================================================
  // SAVING
  // =========================================================================

  /**
   * Saves the profile row on behalf of one section.
   *
   * ⚠️ Sends the WHOLE draft, because the server's update is the whole row with
   * one RowVersion. Only the section's own state and dirty flag are cleared, so
   * a section somebody is still editing does not silently look saved.
   */
  protected saveSection(section: SectionKey): void {
    const draft = this.draft();
    if (draft === null) return;

    /*
      🔴 SR-6. THE SIX ARE CHECKED ON EVERY SECTION'S SAVE, because every
      section's save sends the whole row (see this method's own note above).
      Only the ones the person has CHANGED are judged — the rule and the reason
      are at the top of this class.

      ⚠️ THE TOAST IS FOR THE CROSS-SECTION CASE ONLY. The messages themselves
      render under the boxes in Basic details; if that is the card they are
      looking at, the inline messages are the whole answer and a toast on top of
      them is noise. If they pressed a different section's button, the inline
      message is somewhere they are not looking, and something has to say why
      nothing saved.
    */
    if (!this.validateCompulsory()) {
      if (section !== 'basics') {
        this.toast.error('Nothing was saved. Check the highlighted boxes in Basic details first.');
      }

      return;
    }

    this.setState(section, 'saving');

    this.schools.updateProfile(draft).subscribe({
      next: () => {
        this.setState(section, 'saved');
        this.clearDirty(section);

        // 🔴 Re-read rather than incrementing RowVersion locally. The server
        // owns that number; guessing it right today is guessing it wrong the
        // day a trigger or a second writer touches the row.
        this.schools.getProfile().subscribe({
          next: (profile) => this.applyAfterSave(profile, section),
          error: () => undefined,
        });
      },
      error: (error: unknown) => {
        if (isConflict(error)) {
          // 🔴 Not retried with a fresh RowVersion. That IS the silent
          // overwrite, wearing a helpful face.
          this.setState(section, 'conflict');
          return;
        }

        this.setState(section, 'idle');
      },
    });
  }

  /**
   * Applies a re-read after a save without throwing away other sections' edits.
   */
  private applyAfterSave(profile: SchoolProfile, saved: SectionKey): void {
    this.profile.set(profile);
    this.context.set(profile);

    // Only the RowVersion is taken from the server; the rest of the draft is
    // whatever the user has since typed elsewhere on the page.
    this.draft.update((draft) => (draft === null ? draft : { ...draft, rowVersion: profile.rowVersion }));

    if (saved === 'gallery') {
      this.loadGallery(profile.photos);
    }
  }

  private setState(section: SectionKey, state: SaveState): void {
    this.saveState.update((current) => ({ ...current, [section]: state }));
  }

  private clearDirty(section: SectionKey): void {
    this.dirty.update((current) => {
      const next = new Set(current);
      next.delete(section);

      return next;
    });
  }

  /** The conflict recovery: throw away the local edit and take theirs. */
  protected reloadAfterConflict(): void {
    this.releaseGallery();
    this.load();
    this.toast.info('Reloaded. The other person’s changes are on screen now.');
  }

  // =========================================================================
  // FACILITIES — a full set, which is safe HERE
  // =========================================================================

  protected toggleFacility(facilityId: number, checked: boolean): void {
    this.selectedFacilities.update((current) => {
      const next = new Set(current);
      checked ? next.add(facilityId) : next.delete(facilityId);

      return next;
    });

    this.markDirty('facilities');
  }

  protected hasFacility(facilityId: number): boolean {
    return this.selectedFacilities().has(facilityId);
  }

  /**
   * 🔴 A FULL-SET SYNC — and safe, unlike campus scope.
   *
   * What is ticked is what the school has; anything absent is removed. That
   * holds because a school owner is shown EVERY facility, so the screen really
   * does carry the whole set. 3G found the opposite case one table over, where
   * a partial view plus the same semantics silently revoked access the caller
   * could not see.
   */
  protected saveFacilities(): void {
    this.setState('facilities', 'saving');

    this.schools.saveFacilities([...this.selectedFacilities()]).subscribe({
      next: () => {
        this.setState('facilities', 'saved');
        this.clearDirty('facilities');
      },
      error: () => this.setState('facilities', 'idle'),
    });
  }

  // =========================================================================
  // GALLERY
  // =========================================================================

  private loadGallery(photos: SchoolPhoto[]): void {
    this.releaseGallery();

    const items: GalleryItem[] = [...photos]
      .sort((a, b) => a.displayOrder - b.displayOrder || a.photoId - b.photoId)
      .map((photo) => ({ ...photo, objectUrl: null, failed: false }));

    this.gallery.set(items);

    this.captionDrafts.set(
      Object.fromEntries(items.map((item) => [item.photoId, item.caption ?? ''])),
    );

    for (const item of items) {
      this.schools.loadImage(this.schools.photoUrl(item.photoId)).subscribe({
        next: (objectUrl) => this.patchItem(item.photoId, { objectUrl }),

        // ⚠️ One image that will not load must not take the gallery with it.
        // The tile keeps its caption and its controls and says the picture is
        // missing — which is also the only way somebody can delete a broken row.
        error: () => this.patchItem(item.photoId, { failed: true }),
      });
    }
  }

  private patchItem(photoId: number, patch: Partial<GalleryItem>): void {
    this.gallery.update((items) =>
      items.map((item) => (item.photoId === photoId ? { ...item, ...patch } : item)),
    );
  }

  private releaseGallery(): void {
    for (const item of this.gallery()) {
      if (item.objectUrl) {
        URL.revokeObjectURL(item.objectUrl);
      }
    }

    this.gallery.set([]);
  }

  protected onPhotoChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];

    // The picker keeps the same file selected otherwise, so choosing the same
    // one twice in a row would do nothing the second time.
    input.value = '';

    if (files.length === 0) return;

    this.uploadNext(files, 0, []);
  }

  /**
   * Uploads chosen photos one at a time.
   *
   * ⚠️ Sequential, and each failure is reported on its own. A batch that fails
   * halfway leaves the successful ones uploaded — a failed photo must never
   * clear the others, which is exactly what a single all-or-nothing request
   * would do.
   */
  private uploadNext(files: File[], index: number, failures: string[]): void {
    if (index >= files.length) {
      this.uploading.set(false);

      if (failures.length > 0) {
        this.toast.error(
          `${failures.length} of ${files.length} did not upload: ${failures.join(', ')}. ` +
            'The rest are in your gallery.',
        );
      }

      this.refreshGallery();

      return;
    }

    this.uploading.set(true);

    this.schools.addPhoto(files[index], null, null).subscribe({
      next: () => this.uploadNext(files, index + 1, failures),
      error: () => this.uploadNext(files, index + 1, [...failures, files[index].name]),
    });
  }

  private refreshGallery(): void {
    this.schools.getProfile().subscribe({
      next: (profile) => {
        this.profile.set(profile);
        this.context.set(profile);
        this.draft.update((d) => (d === null ? d : { ...d, rowVersion: profile.rowVersion }));
        this.loadGallery(profile.photos);
      },
      error: () => undefined,
    });
  }

  /**
   * Moves a photo one place, and saves immediately.
   *
   * 🔴 Explicit controls rather than drag: the design system has no drag
   * primitive, and a hand-rolled one that works with a mouse and not with a
   * keyboard would be worse than buttons for the person who most needs it. Up
   * and down are reachable by tab, announced by a screen reader, and work on a
   * phone — where dragging inside a scrolling page is a fight.
   *
   * ⚠️ The complete order is sent, in the array's order. The server used to
   * sort the ids it was given and write insertion order (3F).
   */
  protected movePhoto(photoId: number, direction: -1 | 1): void {
    const items = [...this.gallery()];
    const from = items.findIndex((item) => item.photoId === photoId);
    const to = from + direction;

    if (from < 0 || to < 0 || to >= items.length) return;

    [items[from], items[to]] = [items[to], items[from]];

    // Optimistic: the tiles move now, and the save is confirmed or undone.
    const previous = this.gallery();
    this.gallery.set(items);
    this.setState('gallery', 'saving');

    this.schools.reorderPhotos(items.map((item) => item.photoId)).subscribe({
      next: () => this.setState('gallery', 'saved'),
      error: () => {
        // Put them back. A gallery that shows an order the server does not
        // have is a gallery that lies on the next reload.
        this.gallery.set(previous);
        this.setState('gallery', 'idle');
      },
    });
  }

  protected captionOf(photoId: number): string {
    return this.captionDrafts()[photoId] ?? '';
  }

  protected setCaption(photoId: number, caption: string): void {
    this.captionDrafts.update((current) => ({ ...current, [photoId]: caption }));
  }

  /** Saves a caption when the field loses focus, if it actually changed. */
  protected commitCaption(item: GalleryItem): void {
    const next = this.captionOf(item.photoId).trim();
    const current = item.caption ?? '';

    if (next === current) return;

    this.schools.savePhotoCaption(item.photoId, next || null).subscribe({
      next: () => {
        this.patchItem(item.photoId, { caption: next || null });
        this.toast.success('Caption saved.');
      },
      error: () => this.setCaption(item.photoId, current),
    });
  }

  protected async removePhoto(item: GalleryItem): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Remove this photo?',
      message: item.caption
        ? `"${item.caption}" will no longer appear on your school's page.`
        : 'It will no longer appear on your school’s page.',
      confirmText: 'Remove photo',
      danger: true,
    });

    if (!ok) return;

    this.schools.deletePhoto(item.photoId).subscribe({
      next: () => {
        if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);

        this.gallery.update((items) => items.filter((i) => i.photoId !== item.photoId));
        this.toast.success('Photo removed.');
      },
      error: () => undefined,
    });
  }

  // =========================================================================
  // LOGO
  // =========================================================================

  protected readonly logoUrl = signal<string | null>(null);

  protected onLogoChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) return;

    this.setState('basics', 'saving');

    this.schools.uploadLogo(file).subscribe({
      next: () => {
        this.setState('basics', 'saved');
        this.toast.success('Logo updated.');
        this.loadLogo();
      },
      error: () => this.setState('basics', 'idle'),
    });
  }

  private loadLogo(): void {
    const previous = this.logoUrl();
    if (previous) URL.revokeObjectURL(previous);

    this.logoUrl.set(null);

    this.schools.loadImage(this.schools.logoUrl()).subscribe({
      next: (url) => this.logoUrl.set(url),
      // 404 is the ordinary case: most schools have never uploaded one.
      error: () => this.logoUrl.set(null),
    });
  }

  // =========================================================================
  // GEOGRAPHY — the same degrade the registration form uses (2.47)
  // =========================================================================

  protected onStateChange(stateId: number | null): void {
    this.set('stateId', stateId, 'contact');
    this.set('districtId', null, 'contact');
    this.set('cityId', null, 'contact');
    this.set('tehsilId', null, 'contact');
    this.districts.set([]);
    this.cities.set([]);
    this.tehsils.set([]);

    if (stateId) this.loadDistricts(stateId);
  }

  private loadDistricts(stateId: number): void {
    this.masters.getByParent(MASTER_KEYS.district, stateId).subscribe({
      next: (items) => this.districts.set(items),
      error: () => this.districts.set([]),
    });
  }

  protected onDistrictChange(districtId: number | null): void {
    this.set('districtId', districtId, 'contact');
    this.set('cityId', null, 'contact');
    this.set('tehsilId', null, 'contact');
    this.cities.set([]);
    this.tehsils.set([]);

    if (districtId) {
      this.loadCities(districtId);
    }
  }

  /**
   * CASCADE RULE: the town is the tehsil's parent.
   *
   * 🔴 THIS LEVEL IS NEW HERE — 15 Nov 2026. `t_app_schools.TehsilId` and
   * `AreaOrVillage` have existed since 036 and `USP_UpdateSchoolProfile` had no
   * parameters for them, so this page could not store either. The comment that
   * used to sit where these controls now are said exactly that, and said the
   * box was deliberately absent because of it:
   *
   *     "a school could correct its tehsil, press Save, be told 'Saved', and
   *      nothing would have" been written.
   *
   * That was the right call. The procedure takes both now, and the controls
   * follow the storage rather than preceding it.
   */
  protected onCityChange(cityId: number | null): void {
    this.set('cityId', cityId, 'contact');
    this.set('tehsilId', null, 'contact');
    this.tehsils.set([]);

    if (cityId) {
      this.loadTehsils(cityId);
    }
  }

  protected onTehsilChange(tehsilId: number | null): void {
    this.set('tehsilId', tehsilId, 'contact');
  }

  /**
   * ⚠️ BY TOWN, NOT BY DISTRICT. `m_mdm_city.TehsilId` is the authoritative
   * link, and `MASTER_KEYS.tehsilByCity` is the key that reads it — the
   * district-parented `TEHSIL` branch answers a different question and a plain
   * int id cannot tell the two apart.
   */
  private loadTehsils(cityId: number): void {
    this.masters.getByParent(MASTER_KEYS.tehsilByCity, cityId).subscribe({
      next: (items) => this.tehsils.set(items),
      error: () => this.tehsils.set([]),
    });
  }

  /**
   * ⚠️ FETCHES, AND NOTHING ELSE — the same split `loadDistricts` has, and the
   * reason is `apply()`: restoring a saved address must be able to fill a list
   * without re-entering the cascade that would clear the value it is filling
   * the list in order to show.
   */
  private loadCities(districtId: number): void {
    this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
      next: (items) => this.cities.set(items),
      error: () => this.cities.set([]),
    });
  }

  // =========================================================================
  // LEAVING THE PAGE
  // =========================================================================

  hasUnsavedChanges(): boolean {
    return this.dirty().size > 0;
  }

  unsavedChangesMessage(): string {
    const sections = [...this.dirty()].map((key) => SECTION_LABELS[key]).join(', ');

    return `You have unsaved changes in ${sections}. Leave this page and lose them?`;
  }

  protected readonly skeletonRows = [0, 1, 2];
}

const SECTION_LABELS: Record<SectionKey, string> = {
  basics: 'Basic details',
  about: 'About',
  facilities: 'Facilities',
  gallery: 'Photos',
  contact: 'Contact and address',
};

/**
 * One value, in a form two of them can be compared in.
 *
 * ⚠️ SR-6. A trim, and nothing else. See `isEdited` for why case is left alone
 * and why a surrounding space is not an edit.
 */
function normaliseForComparison(value: string | number | null): string | number | null {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Whether a failed request was the concurrency refusal.
 *
 * Reads the CODE, never the message text (2.12) — a message is written for a
 * person and gets reworded; a code is a contract.
 */
function isConflict(error: unknown): boolean {
  const body = (error as { error?: { code?: string } } | null)?.error;

  return body?.code === 'CONCURRENCY_CONFLICT';
}
