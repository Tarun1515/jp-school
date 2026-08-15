import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ConfirmDialogService,
  HasUnsavedChanges,
  MasterService,
  ToastService,
} from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiBadgeComponent, UiButtonComponent } from 'jp-shared/ui';

import { SchoolContextService } from '../../../core/school-context.service';
import {
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
  imports: [FormsModule, UiBadgeComponent, UiButtonComponent],
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

  // ---- masters ------------------------------------------------------------
  protected readonly boards = signal<Lookup[]>([]);
  protected readonly schoolTypes = signal<Lookup[]>([]);
  protected readonly facilities = signal<Lookup[]>([]);
  protected readonly states = signal<Lookup[]>([]);
  protected readonly districts = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);

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
    });

    this.selectedFacilities.set(new Set(profile.facilityIds));
    this.dirty.set(new Set());
    this.loadGallery(profile.photos);

    if (profile.stateId) {
      this.loadDistricts(profile.stateId);
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
    this.districts.set([]);
    this.cities.set([]);

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
    this.cities.set([]);

    if (districtId) {
      this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
        next: (items) => this.cities.set(items),
        error: () => this.cities.set([]),
      });
    }
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
 * Whether a failed request was the concurrency refusal.
 *
 * Reads the CODE, never the message text (2.12) — a message is written for a
 * person and gets reworded; a code is a contract.
 */
function isConflict(error: unknown): boolean {
  const body = (error as { error?: { code?: string } } | null)?.error;

  return body?.code === 'CONCURRENCY_CONFLICT';
}
