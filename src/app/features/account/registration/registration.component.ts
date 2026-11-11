import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BillingService, MasterService, Plan, ResolvedAddress, ToastService } from 'jp-shared/core';
import { DocumentType, Lookup, MASTER_KEYS, RequestDocument, SaveDraftBody } from 'jp-shared/models';
import { UiAddressSearchComponent, UiComboboxComponent, lookupsToOptions } from 'jp-shared/ui';

import { RegistrationService } from '../../../core/registration.service';

/** The steps, in order. `review` is last and is not editable. */
/*
  🔴 SR-3 ADDS 'logo' AS ITS OWN STEP, between the address and the contacts.

  The client asked for a school image at registration, and it earns a step
  rather than a field at the bottom of another one: it is the only thing on the
  form that needs the user to go and find a file, which is the single most
  likely place to stall. On its own step it is one clear ask with its own
  explanation, and the progress bar shows it being finished.

  ⚠️ THE CONTACT STEP GOT SHORTER IN THE SAME CHANGE — the principal and HR
  fields moved to the profile — so the form is six steps and no longer than it
  was.
*/
/*
  🔴 SR-4 ADDS THE PLAN CHOICE AND DOES **NOT** ADD A SEVENTH STEP.

  ---------------------------------------------------------------------------
  THE DECISION, AND THE THREE REASONS FOR IT
  ---------------------------------------------------------------------------
  The plan question lives inside `review`, as the last block before the submit
  button. STEPS is unchanged.

  1. IT IS NOT A FACT THE ADMIN VERIFIES. Every one of the five collecting
     steps gathers a claim the school makes about itself, which a human then
     checks against the documents in step 5. The plan is a commercial
     preference with no bearing on whether the school exists. Making it a peer
     of those steps would imply it is part of the application being reviewed,
     and the first consequence of that is an admin wondering whether they are
     supposed to approve it.

  2. 🔴 A STEP OF PRICED PLAN CARDS INSIDE A VERIFICATION FORM READS AS A
     CHECKOUT — and that is the exact failure this feature must not have. A
     school picking Standard has bought NOTHING: it starts on the free plan and
     stays there until somebody confirms a payment. A full step with its own
     heading, its own progress segment and three priced cards would feel like
     the payment step of a purchase, and a form that implies a school has
     bought something it has not is the worst possible outcome here.

  3. BESIDE THE SUBMIT BUTTON IS WHERE THE CAVEAT DOES ITS WORK. "You will
     start on the free plan until we have confirmed your payment" has to be
     read, and the last thing read before pressing a button is the thing beside
     it. Three screens earlier it is a sentence they scrolled past.

  ⚠️ AND THE FORM DOES NOT GET LONGER. Six steps was already a lot — SR-3 had
  to shorten the contact step to afford the logo one — and the brief is explicit
  that it must not grow without reason. One radio group does not need a screen.

  ⚠️ WHY `review` AND NOT `basics`. The review step stays a read-only SUMMARY
  of the school's details; the plan block is not part of that summary, it is
  part of the SEND. That distinction is why the plan has no "Edit" link beside
  it like the other sections do — there is nowhere else to edit it.
*/
const STEPS = ['basics', 'address', 'logo', 'contact', 'documents', 'review'] as const;
type Step = (typeof STEPS)[number];

interface StepMeta {
  key: Step;
  label: string;
  /** Shown under the heading — what this step is for, in one line. */
  hint: string;
}

const STEP_META: readonly StepMeta[] = [
  { key: 'basics', label: 'The school', hint: 'Name, board and registration numbers.' },
  { key: 'address', label: 'Where it is', hint: 'The address teachers will see on your jobs.' },
  { key: 'logo', label: 'Your school', hint: 'A logo, or any clear photo of the school.' },
  { key: 'contact', label: 'Who to reach', hint: 'How we reach you about this application.' },
  { key: 'documents', label: 'Documents', hint: 'Proof that the school is what it says it is.' },
  { key: 'review', label: 'Check and send', hint: 'Everything you have entered, before it goes.' },
];

/** Five letters, four digits, one letter. Mirrors the server's rule exactly. */
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * School registration.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE FORM IS LONG, SO LEAVING IT MUST BE SAFE
 * ----------------------------------------------------------------------------
 * Five steps and a handful of document uploads. Somebody will start this at
 * their desk and finish it on a phone that evening, and if the work does not
 * survive that, they do not come back — they have already handed over the
 * effort once.
 *
 * So the draft is saved on the SERVER on every step change, and the draft IS
 * the approval request in Draft status. Documents attach to it from the first
 * upload and never have to be migrated at submit.
 *
 * ----------------------------------------------------------------------------
 * WHAT THIS FORM DELIBERATELY DOES NOT ASK
 * ----------------------------------------------------------------------------
 * A branch list. Verification is school-level, the form is already five steps,
 * and a school that has not decided to use the product should not be
 * enumerating twelve campuses at that moment. One radio asks whether there is
 * more than one campus — a UI flag that changes what the dashboard shows later
 * and nothing about the data. Branch management is Phase 3, after approval.
 *
 * ----------------------------------------------------------------------------
 * 🔴 SR-4: THE FORM NOW OFFERS A PLAN, AND IT BUYS NOTHING
 * ----------------------------------------------------------------------------
 * This used to say the form deliberately asked nothing about price, because
 * "pricing is not finalised, the public FAQ says so, and a number shown during
 * registration is one we would be held to". The client has since asked for the
 * choice to be on the form, and has given figures — PLACEHOLDER figures, which
 * 013_seed_school_plans.sql records and marks in the plan NAME, with a build
 * guard that fails if the marker is removed while they are still dummy.
 *
 * So the reasoning did not go away; it moved into how the numbers are shown:
 *
 *   · the plan NAME is rendered verbatim, carrying "(SAMPLE PRICING)";
 *   · the public FAQ's own hedge is repeated beside the prices, word for word,
 *     rather than reworded into a second caveat that could drift from it;
 *   · "Register as Free" is pre-selected, so the default costs nothing and
 *     commits to nothing.
 *
 * 🔴 AND CHOOSING A PAID PLAN DOES NOT MAKE THE ACCOUNT PAID. It records an
 * intention on the draft. At approval the account is provisioned on the FREE
 * plan — exactly as it always was — and a pending plan-change request is opened
 * beside it for an admin to verify a payment against. The screen says that in
 * so many words, before the submit button and again on the status page, because
 * a form that implies a school has bought something it has not is the single
 * worst thing this feature could do.
 */
@Component({
  selector: 'app-registration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiAddressSearchComponent, FormsModule, UiComboboxComponent],
  templateUrl: './registration.component.html',
  styleUrl: './registration.component.scss',
})
export class RegistrationComponent {
  private readonly registration = inject(RegistrationService);
  private readonly masters = inject(MasterService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /**
   * 🔴 SR-4. The plan catalogue, from the one service that knows about plans.
   *
   * ⚠️ `loadPlans()`, NOT `load()`. The full load also asks for
   * `/billing/my-plan` and `/billing/my-history`, and a school filling in this
   * form has neither — it is applying to exist. Those calls would fail
   * legitimately, set the service's `hasFailed`, and the billing screen would
   * later open saying "your plan could not be loaded" because of a request this
   * form made. `loadPlans()` exists so there is still exactly one place that
   * knows the catalogue's URL (G27).
   */
  private readonly billing = inject(BillingService);

  protected readonly steps = STEP_META;

  protected readonly stepIndex = signal(0);
  protected readonly step = computed<Step>(() => STEPS[this.stepIndex()]);

  protected readonly loading = signal(true);
  protected readonly submitting = signal(false);
  protected readonly saveState = signal<SaveState>('idle');

  /** Per-field messages for the CURRENT step only. */
  protected readonly errors = signal<Record<string, string>>({});

  // ---- the form -----------------------------------------------------------
  protected readonly requestId = signal<number | null>(null);
  private readonly entityUid = signal<string | null>(null);

  /*
    Every select-backed field starts as an explicit NULL, not undefined.

    The placeholder option is `[ngValue]="null"`, and undefined matches no
    option at all — so a fresh form showed empty dropdowns with no "Choose…"
    in them, which reads as a list that failed to load rather than one nobody
    has picked from yet.
  */
  protected readonly form = signal<SaveDraftBody>({
    schoolName: '',
    groupType: 1,
    schoolTypeId: null,
    boardId: null,
    stateId: null,
    districtId: null,
    tehsilId: null,
    cityId: null,
  });

  // ---- masters ------------------------------------------------------------
  protected readonly boards = signal<Lookup[]>([]);
  protected readonly schoolTypes = signal<Lookup[]>([]);
  /*
    ⚠️ P1: DECLARED IN CASCADE ORDER, AND THE ORDER MOVED.

    State -> district -> city -> tehsil. `cities` used to sit below `tehsils`
    because the tehsil narrowed the town list; it is the other way round now
    (see onCityChange), and a reader following the cascade down the file should
    not have to jump back up a line to do it.
  */
  protected readonly states = signal<Lookup[]>([]);
  protected readonly districts = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);
  protected readonly tehsils = signal<Lookup[]>([]);
  protected readonly documentTypes = signal<DocumentType[]>([]);

  /**
   * 🔴 Whether the district/city dataset exists at all.
   *
   * It does not yet (2.47), and the form must degrade to state-only CLEANLY —
   * not a spinner that never resolves, not an empty dropdown with no
   * explanation. Both of those read as "this form is broken" and are the single
   * most likely thing to stop a real registration on day one.
   *
   * So the controls are HIDDEN and one line of copy says why. Hidden, not
   * disabled: a disabled empty dropdown is a thing somebody keeps clicking.
   */
  protected readonly hasDistricts = computed(() => this.districts().length > 0);

  protected readonly hasCities = computed(() => this.cities().length > 0);

  /*
    SR-1 / P1. Tehsil is OPTIONAL and it now hangs off the TOWN rather than
    sitting between district and town — a school that knows only its town must
    still be able to finish. Hidden when the chosen town has no tehsil rows, by
    the same rule as district and city: an empty dropdown reads as a broken
    form.

    🔴 THIS GUARD IS ALSO THE WHOLE DEGRADE FOR A TOWN WE HAVE NOT MAPPED TO A
    TEHSIL. m_mdm_city.TehsilId is nullable on purpose (039_m_mdm_tehsil.sql:
    "a city whose tehsil we have not mapped is a city that still works"), so an
    empty answer here is an ordinary, expected outcome and not a failure — the
    control disappears, nothing else on the step moves, and the form still
    submits.
  */
  protected readonly hasTehsils = computed(() => this.tehsils().length > 0);

  /*
    SR-3 (G27). The masters behind every dropdown on this form, as combobox
    options.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE. `lookupsToOptions(states())`
    written in the binding rebuilds the array on every change-detection pass and
    hands <ui-combobox> a new `options` identity each time — which defeats the
    OnPush it was given. A computed changes identity only when the master behind
    it actually changes, which for a cascading address form is exactly the four
    moments that matter.

    ⚠️ P1 ADDS BOARD AND SCHOOL TYPE, and they obey the same rule for the same
    reason even though they never cascade: the identity trap is a property of
    the binding, not of the master.
  */
  protected readonly stateOptions = computed(() => lookupsToOptions(this.states()));
  protected readonly districtOptions = computed(() => lookupsToOptions(this.districts()));
  protected readonly cityOptions = computed(() => lookupsToOptions(this.cities()));
  protected readonly tehsilOptions = computed(() => lookupsToOptions(this.tehsils()));

  /*
    P1 (G27). The last two plain <select>s on this form, now the one searchable
    select like everything else.

    ⚠️ BOTH ARE SHORT — seven boards and six school types — AND THAT COSTS
    NOTHING. <ui-combobox> only grows a search box at `searchFrom` (8) options,
    so below it the control opens showing everything and reads as the plain list
    it was. The reason to convert anyway is G27: one select, so a fix to
    keyboard handling or to the open-list positioning lands everywhere at once
    rather than everywhere except two boxes nobody remembered.
  */
  protected readonly boardOptions = computed(() => lookupsToOptions(this.boards()));
  protected readonly schoolTypeOptions = computed(() => lookupsToOptions(this.schoolTypes()));

  // ---- documents ----------------------------------------------------------
  protected readonly uploaded = signal<RequestDocument[]>([]);
  protected readonly uploading = signal<number | null>(null);

  /** SR-3: the logo upload is its own state — it is not a document type. */
  protected readonly logoUploading = signal(false);
  protected readonly logoError = signal<string | null>(null);

  /**
   * A preview of the file THEY just chose, straight from the browser.
   *
   * 🔴 NOT FETCHED BACK FROM THE SERVER, and that is not laziness. Uploads
   * live under App_Data, which is not served statically and must never be —
   * teacher resumes and registration documents share that root. Previewing
   * from the server would mean a new authenticated media route for a picture
   * the browser already has in its hand.
   *
   * ⚠️ SO IT IS EMPTY AFTER A RELOAD, when the draft is resumed and there is
   * no File object any more. The template handles that case separately and
   * says the image is saved rather than showing a broken one — which is why
   * this is a preview, and the saved state is logoPath.
   */
  protected readonly logoPreview = signal<string | null>(null);

  /** Which document types this request needs, mandatory first. */
  protected readonly slots = computed(() =>
    this.documentTypes()
      .filter((d) => d.requestTypeId === 1)
      .sort((a, b) => Number(b.isMandatory) - Number(a.isMandatory) || a.displayOrder - b.displayOrder),
  );

  protected readonly missingMandatory = computed(() =>
    this.slots().filter((s) => s.isMandatory && !this.documentFor(s.id)),
  );

  protected readonly canSubmit = computed(
    () => !!this.requestId() && this.missingMandatory().length === 0 && !this.submitting(),
  );

  // ---- the plan choice (SR-4) ---------------------------------------------
  /**
   * Every plan a school may register on, in the catalogue's own order.
   */
  protected readonly plans = this.billing.plans;

  /**
   * 🔴 THE FREE PLAN, FOUND BY ITS `isDefault` FLAG — NOT BY ITS CODE.
   *
   * The default plan is a property of the catalogue (one per user type, held by
   * a unique index), and it is the SAME row provisioning reads to decide what a
   * new account starts on. Deriving it here means this screen and provisioning
   * cannot disagree about which plan "free" is, where
   * `find(p => p.planCode === 'SCHOOL_FREE')` would be this component's own
   * second opinion.
   *
   * ⚠️ The price fallback is for a catalogue that somehow has no default at
   * all: a free plan is still a better guess than the first row, which could be
   * a paid one. Provisioning refuses outright in that case, so the honest
   * outcome here is that no paid plan gets pre-selected either.
   */
  protected readonly freePlan = computed<Plan | null>(
    () => this.plans().find((p) => p.isDefault)
      ?? this.plans().find((p) => p.price === 0)
      ?? null,
  );

  /** The paid tiers, cheapest first — the catalogue's DisplayOrder. */
  protected readonly paidPlans = computed(() =>
    this.plans().filter((p) => p.planId !== this.freePlan()?.planId));

  /**
   * What the radio group shows as selected.
   *
   * 🔴 "REGISTER AS FREE" IS PRE-SELECTED, which is the client's instruction
   * and also the only pre-selection that can be made honestly: it is the plan
   * the account is actually going to be on when it is approved, whatever is
   * chosen here.
   *
   * ⚠️ A NULL draft value FALLS BACK to free rather than to nothing. Null means
   * "not answered yet" — a draft started before this question existed — and
   * showing no selection at all would make a school think it had to choose
   * before it could send.
   */
  protected readonly chosenPlanCode = computed(
    () => this.value('requestedPlanCode') ?? this.freePlan()?.planCode ?? null);

  /** The chosen plan's row, when the catalogue has arrived. */
  protected readonly chosenPlan = computed<Plan | null>(
    () => this.plans().find((p) => p.planCode === this.chosenPlanCode()) ?? null);

  /**
   * 🔴 THE HONESTY FLAG. True when the school has asked for something it is
   * not going to have when the account opens.
   *
   * Everything the screen says about "you will start on the free plan" hangs
   * off this one predicate, so there is no path where a paid choice is shown
   * without the caveat beside it.
   */
  protected readonly chosePaidPlan = computed(() => {
    const chosen = this.chosenPlan();

    return chosen !== null && chosen.planId !== this.freePlan()?.planId;
  });

  /**
   * 🔴 The hedge, in the words the public FAQ already uses.
   *
   * The seeded answer to "What does it cost?" is exactly this sentence
   * (jp_app/03_seed/003_seed_public_faqs.sql), and the billing page repeats the
   * same one. Three surfaces, one sentence: a reworded version here would be a
   * second caveat to keep in step, and the one that goes stale is always the one
   * in code rather than the one the client can read as data.
   */
  protected readonly pricingHedge =
    'Pricing is not finalised. If you are registering now, talk to us first so '
    + 'there are no surprises later.';

  /**
   * ⚠️ True while a paid plan on offer still carries the placeholder marker.
   *
   * Read off the catalogue, not hardcoded, so the caveat disappears by itself
   * the day the real list arrives: 013_seed_school_plans.sql changes the Price
   * and drops "(SAMPLE PRICING)" from the names in ONE commit, which its own
   * build guard insists on.
   */
  protected readonly pricesArePlaceholders = computed(() =>
    this.plans().some((p) => p.price > 0 && p.name.includes('SAMPLE PRICING')));

  constructor() {
    for (const [key, target] of [
      [MASTER_KEYS.board, this.boards],
      [MASTER_KEYS.schoolType, this.schoolTypes],
      [MASTER_KEYS.state, this.states],
    ] as const) {
      this.masters.get(key).subscribe({
        next: (items) => target.set(items),
        error: () => target.set([]),
      });
    }

    /*
      🔴 From the BULK endpoint, not /api/masters/document-type.

      The generic master shape is Id / Code / Name / DisplayOrder / ParentId,
      and it drops the only three fields that make a document type more than a
      name: IsMandatory, MaxSizeKb and AllowedExtensions.

      Reading the generic one gave a form where nothing was ever marked
      required — so the "you still need this" gate passed silently on an empty
      upload step — and where the size hint was invented rather than read from
      the row that actually enforces it (2.47).
    */
    this.registration.documentTypes().subscribe({
      next: (items) => this.documentTypes.set(items),
      error: () => this.documentTypes.set([]),
    });

    /*
      🔴 SR-4. The plans, from the server, for the review step's choice.

      ⚠️ A FAILURE IS NOT FATAL AND NOT ANNOUNCED. `plans()` stays empty, the
      plan block renders the free option alone, the draft carries no paid code
      and the account opens on the free plan — which is the state a school would
      have been in anyway. Blocking a registration because a price list could
      not be fetched would cost us the account over something nobody asked for
      yet.
    */
    this.billing.loadPlans();

    this.registration.getDraft().subscribe({
      next: (draft) => {
        if (draft) {
          this.requestId.set(draft.header.requestId);
          this.entityUid.set(draft.header.entityUid);
          this.uploaded.set(draft.documents);

          if (draft.schoolDetail) {
            const d = draft.schoolDetail;
            this.form.set({
              schoolName: d.schoolName,
              schoolTypeId: d.schoolTypeId,
              boardId: d.boardId,
              affiliationNumber: d.affiliationNumber,
              registrationNo: d.registrationNo,
              panNumber: d.panNumber,
              groupType: d.groupType ?? 1,
              establishedYear: d.establishedYear,
              addressLine1: d.addressLine1,
              addressLine2: d.addressLine2,
              cityId: d.cityId,
              districtId: d.districtId,
              stateId: d.stateId,
              pincode: d.pincode,

              /*
                🔴 THESE FIVE WERE NOT CARRIED BACK, AND THE DRAFT SAVE WIPED
                THEM ON THE NEXT STEP CHANGE.

                `save()` posts `{ ...this.form() }`, and
                USP_SaveSchoolRegistrationDraft's UPDATE branch assigns every
                address column unconditionally — `TehsilId = @TehsilId`. A field
                this object does not rebuild arrives as null and is written as
                null. So a school that picked a tehsil on Monday, came back on
                Thursday and pressed Continue once had silently lost its tehsil,
                its village name and (for an address matched through Places) its
                coordinates and place id.

                ⚠️ SAME CLASS OF BUG AS THE ONE SR-3 RECORDS ON THE CONTACT
                STEP: a field the form collected and the next step did not
                carry. P1 depends on the tehsil surviving a resume — the control
                is populated from the saved town — so it is fixed here rather
                than worked around.

                ⚠️ LATITUDE, LONGITUDE AND GooglePlaceId ARE CARRIED THOUGH THIS
                FORM NEVER ASKS FOR THEM. They are set by the Places lookup
                (JP.Domain/Address), and a form that cannot show a value still
                must not be the thing that deletes it.
              */
              tehsilId: d.tehsilId,
              areaOrVillage: d.areaOrVillage,
              latitude: d.latitude,
              longitude: d.longitude,
              googlePlaceId: d.googlePlaceId,

              /*
                🔴 AND logoPath, WHICH WAS THE SAME OMISSION WITH A LOUDER
                SYMPTOM — FOUND WHILE FIXING THE FIVE ABOVE.

                The logo step REQUIRES it (`validate('logo')`), so a school that
                uploaded its logo on Monday and came back on Thursday was
                stopped on that step and told to add a logo it had already
                added; the only way past was to upload the file again. The
                template's own "Your image is saved. Choose another file to
                replace it." branch could never render, because the value it
                tests was never restored.

                ⚠️ AND THE NEXT SAVE WOULD HAVE CLEARED LogoPath on the
                registration row, by the same unconditional assignment as the
                address columns — losing a file that is already on disk and that
                nothing else points at.
              */
              logoPath: d.logoPath,
              principalName: d.principalName,
              principalMobile: d.principalMobile,
              hrContactName: d.hrContactName,
              hrContactMobile: d.hrContactMobile,
              contactEmail: d.contactEmail,
              contactMobile: d.contactMobile,
              website: d.website,
              aboutSchool: d.aboutSchool,

              /*
                🔴 SR-4. Carried back onto a resumed draft like every other
                field. A school that chose Standard on Monday and finishes on
                Thursday must find Standard still selected — a choice that
                silently reverted to Free would be the mirror image of the
                dishonesty this feature is built to avoid, and the school would
                only find out weeks later when no invoice arrived.
              */
              requestedPlanCode: d.requestedPlanCode,
            });

            /*
              🔴 EVERY DEPENDENT LIST IS FETCHED FROM THE SAVED IDS, IN ONE GO —
              NOT CHAINED ON EACH OTHER'S RESPONSES.

              Each control is hidden until its own list arrives
              (`hasDistricts`/`hasCities`/`hasTehsils`), so a list nobody
              fetched is a control nobody draws: resuming a draft that HAD a
              town used to show no town control at all, the value sitting in the
              form unreadable and unchangeable until the user re-picked the
              district. Loading only the districts fixes one level of a
              three-level cascade.

              ⚠️ THE PARENT OF EVERY LEVEL IS ALREADY IN HAND, which is why
              nothing has to wait for anything: the draft carries stateId,
              districtId and cityId together. Waterfalling the three requests
              would add two round-trips to a resumed form for no information we
              did not already have.

              ⚠️ THROUGH THE loadX HELPERS, NOT THE onXChange HANDLERS. The
              handlers also CLEAR the levels below them — right when a person
              changes a parent, wrong when we are restoring what they saved, and
              it would wipe the tehsil this same commit stopped losing.

              ⚠️ ORDER OF ARRIVAL DOES NOT MATTER TO THE LABEL. <ui-combobox>
              derives its text from `options()` and the value through a computed
              (`selected`), so a value written before its options land renders
              the moment they do. What the fetch buys is the control existing at
              all.
            */
            if (d.stateId) {
              this.loadDistricts(d.stateId);
            }

            if (d.districtId) {
              this.loadCities(d.districtId);
            }

            if (d.cityId) {
              this.loadTehsilsForCity(d.cityId);
            }
          }

          this.toast.info('We picked up where you left off.');
        }

        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // ---- field plumbing -----------------------------------------------------
  protected value<K extends keyof SaveDraftBody>(key: K): SaveDraftBody[K] {
    return this.form()[key];
  }

  protected set<K extends keyof SaveDraftBody>(key: K, value: SaveDraftBody[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));

    // Clearing the error as they type, rather than waiting for the next
    // attempt: an error that stays after it is fixed teaches people to ignore
    // errors.
    if (this.errors()[key as string]) {
      this.errors.update((e) => {
        const next = { ...e };
        delete next[key as string];
        return next;
      });
    }
  }

  protected error(key: string): string | undefined {
    return this.errors()[key];
  }

  /*
    ==========================================================================
    🔴 P1: THE CASCADE, AND WHY ITS SHAPE CHANGED
    ==========================================================================
    The form used to ask State -> District -> Tehsil -> Town, which is the
    administrative hierarchy and is not how anybody thinks about where they are.
    Worse, where a tehsil and its headquarters town share a name — Gohana
    tehsil and Gohana town, and in Haryana that is EVERY town, because
    012_seed_haryana_geography.sql seeds one city per tehsil as its headquarters
    — the user met the same word in two different boxes and picked the wrong
    one.

    So the form now asks

        State -> District -> Town/city -> Tehsil/Sub-tehsil -> Village/area

    and each control is DRIVEN BY THE ONE ABOVE IT. The town is the thing people
    know; the tehsil is a detail of the town, offered after it and never
    required.

    🔴 THE DATA DID NOT MOVE. m_mdm_city keeps its NOT NULL DistrictId and its
    nullable TehsilId, and the payload still carries stateId, districtId,
    cityId, tehsilId and areaOrVillage under those names. This is the order of
    five questions, not a new shape for the answers.

    ⚠️ THE CLEARING RULES, IN ONE PLACE, BECAUSE THEY ARE THE EASY THING TO GET
    WRONG:

      state    changes -> district, town, tehsil and village all go
      district changes -> town, tehsil and village go; towns refetched
      town     changes -> tehsil goes and is refetched FROM THE TOWN;
                          village is KEPT
      town     cleared -> tehsil goes with it, because a tehsil without its
                          parent town is a selection the form can no longer
                          explain
      tehsil   changes -> nothing. It is the leaf; the village box below it is
                          free text about a place, not a child of the tehsil.

    ⚠️ VILLAGE IS CLEARED BY STATE AND DISTRICT BUT NOT BY TOWN, and that is a
    judgement rather than a symmetry: it is the user's own words for a place,
    and two towns in one district share the villages between them often enough
    that re-picking the town does not make "Dhani Bhagwan Das" wrong. Changing
    the DISTRICT does make it wrong, and a village name left behind under a new
    district is worse than an empty box — it would be saved as fact.
  */

  /**
   * State changed, so the district list has to be refetched — and everything
   * below it belongs to a state they are no longer in.
   */
  protected onStateChange(stateId: number | null): void {
    this.set('stateId', stateId);
    this.set('districtId', null);
    this.set('cityId', null);
    this.set('tehsilId', null);
    this.set('areaOrVillage', null);
    this.districts.set([]);
    this.cities.set([]);
    this.tehsils.set([]);

    if (stateId) {
      this.loadDistricts(stateId);
    }
  }

  private loadDistricts(stateId: number): void {
    this.masters.getByParent(MASTER_KEYS.district, stateId).subscribe({
      next: (items) => this.districts.set(items),
      // An empty list and a failed call look the same to the form on purpose:
      // both mean "no districts to offer", and both degrade to state-only.
      error: () => this.districts.set([]),
    });
  }

  /**
   * District changed. The town hangs off the district and the tehsil hangs off
   * the town, so both go and the town list is refetched.
   */
  protected onDistrictChange(districtId: number | null): void {
    this.set('districtId', districtId);
    this.set('cityId', null);
    this.set('tehsilId', null);
    this.set('areaOrVillage', null);
    this.cities.set([]);
    this.tehsils.set([]);

    if (!districtId) {
      return;
    }

    this.loadCities(districtId);
  }

  /**
   * 🔴 EVERY TOWN OF THE DISTRICT, AS SOON AS THE DISTRICT IS KNOWN.
   *
   * This fetch used to be justified by the tehsil step being optional: the
   * towns of the whole district were loaded up front rather than after a
   * tehsil, because waiting for an optional step would mean a school that
   * skipped it never saw a town at all — the shape of "optional" that is really
   * "required and badly labelled".
   *
   * 🔴 P1 KEEPS THAT OUTCOME AND REMOVES THE WAY TO LOSE IT. The town no longer
   * waits on anything optional: the district is its only parent in the form,
   * and the tehsil hangs off the town instead. There is now no order of
   * clicking in which a school reaches the end of the cascade with an empty
   * town list.
   *
   * ⚠️ The endpoint is unchanged — `district` as the parent still returns
   * `DistrictId AS ParentId` for the towns of that district (USP_GetMaster,
   * 'CITY'). What P1 drops is the second call that re-asked for the same towns
   * narrowed by tehsil.
   */
  private loadCities(districtId: number): void {
    this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
      next: (items) => this.cities.set(items),
      error: () => this.cities.set([]),
    });
  }

  /**
   * The town changed, so the tehsil under it is refetched from the new town.
   *
   * 🔴 THE TEHSIL IS CLEARED FIRST, EVERY TIME, INCLUDING WHEN THE TOWN IS
   * CLEARED. A tehsil is now a detail OF a town; keeping one after its parent
   * changed would leave the form holding a tehsil that the new town cannot
   * explain and that the user never chose for it. It is a cheap thing to
   * re-pick and an expensive thing to get silently wrong in a saved address.
   *
   * ⚠️ THE VILLAGE TEXT STAYS. See the clearing rules above: it is the user's
   * own words, and moving between towns of one district does not make them
   * wrong.
   */
  protected onCityChange(cityId: number | null): void {
    this.set('cityId', cityId);
    this.set('tehsilId', null);
    this.tehsils.set([]);

    if (cityId) {
      this.loadTehsilsForCity(cityId);
    }
  }

  /**
   * The tehsils of ONE TOWN.
   *
   * ----------------------------------------------------------------------------
   * 🔴 THE AUTHORITATIVE LINK IS m_mdm_city.TehsilId, AND THE CLIENT CANNOT SEE
   *    IT
   * ----------------------------------------------------------------------------
   * A town's tehsil is a column on the town's own row, and
   * 039_m_mdm_tehsil.sql's build guard asserts that when it is set it belongs to
   * that town's district — two paths to one district that are proven to agree.
   *
   * But `Lookup` is id / code / name / displayOrder / parentId, and there is no
   * room in it for a second parent. Widening that shape is not a local change:
   * every master in four applications travels in it, so a sixth field would
   * touch every consumer of MasterService to serve one form. So the server
   * answers the question instead, and this method is the only place that asks
   * it — which is also what makes the switch below a one-line change.
   *
   * ⚠️ THE ALTERNATIVE WAS A NAME MATCH — pre-select the tehsil whose name
   * equals the chosen town's — and it was rejected on purpose. In Haryana every
   * town IS a tehsil headquarters with the same name, so it would look right in
   * testing while being a guess standing in for a foreign key; the first town
   * that was renamed, or that sits in a tehsil named after somewhere else,
   * would silently get the wrong one.
   *
   * ----------------------------------------------------------------------------
   * ⚠️⚠️ TODO (LEAD) — REPOINT THIS CALL WHEN THE MASTER KEY LANDS
   * ----------------------------------------------------------------------------
   * `MASTER_KEYS.tehsil` is TEHSIL-BY-DISTRICT today: USP_GetMaster's 'TEHSIL'
   * branch filters `DistrictId = @ParentId`, so passing a city id matches
   * nothing and this returns an EMPTY LIST — the control hides and the tehsil
   * question cannot be answered at all until the backend lands.
   *
   * It cannot return a WRONG list: district ids are stateId*100 + n (3-4
   * digits) and city ids are stateId*10000 + n (5-6 digits), so a city id
   * cannot collide with a district id and the failure mode is silence, not
   * nonsense.
   *
   * WHAT HAS TO CHANGE, AND NOTHING ELSE:
   *   1. jp-shared src/core/models/lookup.model.ts — a new key beside `tehsil`
   *      for "the tehsils of this city" (the server's whitelist name, e.g.
   *      'tehsil-by-city'). NOT ADDED HERE: jp-shared is the lead's.
   *   2. the `MASTER_KEYS.tehsil` argument on the one line below.
   */
  private loadTehsilsForCity(cityId: number): void {
    // ✅ Repointed by the lead: `tehsil-by-city` resolves through `m_mdm_city.TehsilId`.
    this.masters.getByParent(MASTER_KEYS.tehsilByCity, cityId).subscribe({
      next: (items) => this.tehsils.set(items),

      /*
        An empty list and a failed call look the same to the form on purpose,
        exactly as they do for districts: both mean "no tehsil to offer here",
        the control hides, and the address is still complete without it.
      */
      error: () => this.tehsils.set([]),
    });
  }

  /**
   * An address picked in the search box, written into the same fields the
   * cascade writes.
   *
   * ============================================================================
   * 🔴 THE SEQUENCING IS THE DRAFT-RELOAD PATH'S, NOT THE onXChange HANDLERS'
   * ============================================================================
   * This is the same problem the constructor solves when it resumes a saved
   * draft: ids arriving all at once, and every dependent list having to exist so
   * its control is drawn and can show the value. So it is done the same way, and
   * deliberately not any other way:
   *
   *   1. all the ids are written in ONE update;
   *   2. the three lists are emptied, because every one of them belongs to a
   *      parent that has just changed;
   *   3. `loadDistricts` / `loadCities` / `loadTehsilsForCity` are called FROM
   *      THE RESOLVED IDS, all three issued together — nothing waits for
   *      anything, because every parent is already in hand.
   *
   * 🔴 NOT `onStateChange` / `onDistrictChange` / `onCityChange`. Those three
   * also CLEAR the level below them — right when a person changes a parent, and
   * catastrophic here: calling them in cascade order would wipe the district,
   * town and tehsil this method has just resolved, and the form would end up
   * holding a state and nothing else. The loadX helpers only fill a signal,
   * which is exactly what is wanted. The constructor's draft reload carries the
   * same warning for the same reason.
   *
   * ⚠️ P1'S PARENTAGE: district -> CITY -> tehsil. The tehsil list comes from
   * the TOWN (`MASTER_KEYS.tehsilByCity`), not from the district, so the third
   * call takes `cityId`. A tehsil resolved for a town whose list we never
   * fetched would sit in the form unreadable, because `hasTehsils()` hides a
   * control with an empty list.
   *
   * ----------------------------------------------------------------------------
   * 🔴 WHAT IS REPLACED, AND WHAT IS KEPT
   * ----------------------------------------------------------------------------
   * The five geography ids, the coordinates and the place id are replaced AS A
   * SET, including with nulls. They describe ONE place; keeping a district from
   * the address somebody looked up two minutes ago beside a state from this one
   * produces a row nobody chose and nobody can explain — and it would make the
   * "we could not find that district" note a lie, because the box would not be
   * empty.
   *
   * ⚠️ THE USER'S OWN WORDS ARE NEVER OVERWRITTEN. `addressLine1` and
   * `areaOrVillage` are filled only when they are empty: the provider's street
   * line is a decent guess, and the text somebody typed about where their school
   * is was never a guess. A village name in particular has no master to be
   * matched against (ADDRESS_DESIGN §2) and is often the only part of an address
   * the provider has never heard of.
   *
   * ⚠️ AND THE PIN CODE IS KEPT WHEN THE PROVIDER HAS NONE. Places frequently
   * answers an establishment-level result with no postal_code, and deleting a
   * PIN the school typed correctly because a third party said nothing is the
   * exact failure this whole feature is written to avoid.
   *
   * ⚠️ NO SAVE HAPPENS HERE. The draft is persisted by `next()` on the step
   * change, which is the very next thing this step can do — unlike the plan
   * choice (SR-4), which is made on the last step where no step change follows
   * and therefore has to save itself.
   */
  protected onAddressResolved(address: ResolvedAddress): void {
    this.form.update((f) => ({
      ...f,

      // One place, one set of ids.
      stateId: address.stateId,
      districtId: address.districtId,
      cityId: address.cityId,
      tehsilId: address.tehsilId,
      latitude: address.latitude,
      longitude: address.longitude,
      googlePlaceId: address.googlePlaceId,

      // Theirs unless it is empty; the provider's only as a starting point.
      addressLine1: f.addressLine1?.trim() ? f.addressLine1 : address.addressLine1,
      areaOrVillage: f.areaOrVillage?.trim() ? f.areaOrVillage : address.areaOrVillage,
      pincode: address.pincode ?? f.pincode,
    }));

    /*
      ⚠️ The messages for the fields this just filled go with them. `set()`
      clears an error as the user types for the same reason: an error still
      showing after it has been fixed teaches people to ignore errors.
    */
    this.errors.update((e) => {
      const next = { ...e };

      for (const key of ['addressLine1', 'stateId', 'pincode']) {
        delete next[key];
      }

      return next;
    });

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
      this.loadTehsilsForCity(address.cityId);
    }
  }

  /**
   * The school's logo or photo.
   *
   * ⚠️ UPLOADED IMMEDIATELY, STORED IN THE DRAFT. The file goes up on
   * selection so the user sees it worked; the PATH is then saved with the
   * draft like every other field, which keeps the draft the single source of
   * truth for a registration (2.50).
   *
   * ⚠️ A FAILURE IS SHOWN WHERE THEY ARE LOOKING, not as a toast. The server
   * refuses by extension, magic bytes and size (2.48), and each refusal is a
   * sentence somebody can act on — a toast that scrolls away is not.
   */
  protected onLogoPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.logoUploading.set(true);
    this.logoError.set(null);

    this.registration.uploadLogo(file).subscribe({
      next: (path) => {
        this.logoUploading.set(false);
        this.set('logoPath', path);

        /*
          ⚠️ The previous object URL is revoked before a new one replaces it.
          Each createObjectURL holds its blob in memory until revoked, and a
          user trying four photos would otherwise pin all four.
        */
        const previous = this.logoPreview();

        if (previous) {
          URL.revokeObjectURL(previous);
        }

        this.logoPreview.set(URL.createObjectURL(file));

        /*
          ⚠️ The input is cleared so picking the SAME file again still fires a
          change event — otherwise a retry after a failure silently does
          nothing, which reads as the button being broken.
        */
        input.value = '';
      },
      error: (err: unknown) => {
        this.logoUploading.set(false);
        input.value = '';

        const message = (err as { error?: { message?: string } })?.error?.message;

        this.logoError.set(message || 'That file could not be uploaded. Try a JPG or PNG under 10 MB.');
      },
    });
  }

  // ---- the plan choice (SR-4) ---------------------------------------------
  /**
   * 🔴 SAVES IMMEDIATELY, AND THAT IS NOT BELT-AND-BRACES — IT IS THE BUG.
   *
   * The draft is normally persisted by `next()` on a step change. The plan
   * choice is made ON the last step, and `submit()` does NOT save first: it
   * posts the request id to `/draft/{id}/submit` and the server reads whatever
   * is already stored. So a plan chosen on the review screen and not saved here
   * would be dropped between the click and the registration — the school would
   * have asked for Standard, seen it selected, pressed send, and got nothing.
   *
   * That is the same class of failure SR-0 found in
   * USP_ProvisionSchoolFromApproval: a field the form collected and the next
   * step never carried. One save call is the whole fix, and the step header's
   * existing "Saving… / Saved" indicator reports it without a toast.
   */
  protected choosePlan(planCode: string): void {
    if (planCode === this.value('requestedPlanCode')) return;

    this.set('requestedPlanCode', planCode);
    this.save();
  }

  /**
   * ⚠️ "Free", not "₹0". The free plan's price is zero and a price tag reading
   * ₹0 beside two real figures invites the reader to wonder what the catch is.
   *
   * ⚠️ The duration is named when there is one, because ₹1,499 means nothing
   * without "for 30 days" beside it — and the catalogue carries DurationDays
   * precisely so a screen never has to assume "per month".
   */
  protected priceLabel(plan: Plan): string {
    if (plan.price === 0) return 'Free';

    return plan.durationDays === null
      ? `₹${plan.price.toLocaleString('en-IN')}`
      : `₹${plan.price.toLocaleString('en-IN')} for ${plan.durationDays} days`;
  }

  /**
   * What a plan includes, as one short line.
   *
   * ⚠️ DELIBERATELY BRIEFER THAN THE BILLING PAGE'S TABLE. This is a
   * registration form, and the full comparison lives on /billing where a school
   * can read it with its real usage beside it. Reproducing that table here
   * would be the second copy G27 warns about — and it would turn the block into
   * the pricing page this step must not become.
   *
   * ⚠️ `null` is "Unlimited", never "0" — the engine's convention, and the one a
   * screen is most likely to get backwards.
   */
  protected includesLine(plan: Plan): string {
    const parts = plan.features
      .filter((f) => f.isIncluded)
      .map((f) => (f.quotaPerPeriod === null ? `${f.featureName}: unlimited` : `${f.featureName}: ${f.quotaPerPeriod}`));

    return parts.length > 0 ? parts.join(' · ') : 'The basics, to get you started.';
  }

  // ---- validation, per step ----------------------------------------------
  /**
   * Only the step in front of them.
   *
   * Validating the whole form at submit and dumping twelve messages is how a
   * long form becomes something people abandon: the errors are on steps they
   * cannot see, and fixing one does not visibly help.
   */
  private validate(step: Step): boolean {
    const f = this.form();
    const errors: Record<string, string> = {};

    if (step === 'basics') {
      if (!f.schoolName?.trim()) {
        errors['schoolName'] = 'We need the name as it appears on your registration certificate.';
      }

      if (f.establishedYear && (f.establishedYear < 1800 || f.establishedYear > new Date().getFullYear())) {
        errors['establishedYear'] = 'That year does not look right.';
      }

      // ⚠️ Optional, so only a MALFORMED value is an error. Same rule as the
      // server — the client checking something stricter would reject a PAN the
      // API would have accepted.
      if (f.panNumber?.trim() && !PAN_FORMAT.test(f.panNumber.trim().toUpperCase())) {
        errors['panNumber'] = 'A PAN is ten characters — five letters, four digits, then a letter. For example ABCDE1234F.';
      }
    }

    if (step === 'address') {
      if (!f.addressLine1?.trim()) {
        errors['addressLine1'] = 'Teachers see this address on your job posts.';
      }

      if (!f.stateId) {
        errors['stateId'] = 'Pick the state.';
      }

      if (f.pincode?.trim() && !/^[1-9][0-9]{5}$/.test(f.pincode.trim())) {
        errors['pincode'] = 'An Indian PIN code is six digits and does not start with a zero.';
      }
    }

    if (step === 'logo') {
      /*
        🔴 REQUIRED, which is the client's instruction — and FIELD_MATRIX.md
        §A1 records the caution that went with it: a school registering from a
        phone at night that cannot find its logo file will stop here. So the
        ask is "a logo OR any photo of the school", which is a question
        anybody can answer, and the copy says exactly that.

        ⚠️ If the client ticks "optional" on the matrix, this block is the one
        line that changes.
      */
      if (!f.logoPath) {
        errors['logoPath'] = 'Add a logo or a photo of your school so teachers can recognise you.';
      }
    }

    if (step === 'contact') {
      if (!f.contactEmail?.trim()) {
        errors['contactEmail'] = 'We send verification updates to this address.';
      }

      if (f.contactEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contactEmail.trim())) {
        errors['contactEmail'] = 'That email address does not look complete.';
      }

      /*
        ⚠️ SR-3: principalMobile and hrContactMobile were validated here and
        are no longer ASKED here — they moved to the profile. Validating a
        field the form does not show can only ever block a submit with a
        message pointing at a box that is not on screen.

        🔴 THE DRAFT STILL CARRIES THEM. A school that started registering
        before this change has values in those fields, and they are sent on
        unchanged — the matrix moves fields, it does not orphan data.
      */
      for (const [key, label] of [
        ['contactMobile', 'contact'],
      ] as const) {
        const value = (f[key] as string | null | undefined)?.trim();

        if (value && !/^[6-9][0-9]{9}$/.test(value)) {
          errors[key] = `An Indian mobile number is ten digits starting 6 to 9. Check the ${label} number.`;
        }
      }

      if (!f.contactMobile?.trim()) {
        errors['contactMobile'] = 'A number we can call if something is unclear.';
      }
    }

    this.errors.set(errors);

    return Object.keys(errors).length === 0;
  }

  // ---- navigation ---------------------------------------------------------
  protected next(): void {
    if (!this.validate(this.step())) {
      return;
    }

    this.save();
    this.stepIndex.update((i) => Math.min(i + 1, STEPS.length - 1));
    this.scrollUp();
  }

  /**
   * Back never validates and never blocks.
   *
   * Somebody going back to check what they typed must not be stopped by an
   * error on the step they are trying to leave — that is a trap, and the draft
   * has their input either way.
   */
  protected back(): void {
    this.errors.set({});
    this.stepIndex.update((i) => Math.max(i - 1, 0));
    this.scrollUp();
  }

  /** From the review step's edit links. */
  protected goToStep(key: Step): void {
    this.errors.set({});
    this.stepIndex.set(STEPS.indexOf(key));
    this.scrollUp();
  }

  private scrollUp(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- draft --------------------------------------------------------------
  protected save(): void {
    this.saveState.set('saving');

    this.registration
      .saveDraft({ ...this.form(), entityUid: this.entityUid() })
      .subscribe({
        next: (result) => {
          this.requestId.set(result.requestId);
          this.entityUid.set(result.entityUid);
          this.saveState.set('saved');
        },
        error: () => {
          // Said in the step header rather than a toast: a toast about a
          // background save that the person did not ask for is noise, but
          // silently not saving is worse than either.
          this.saveState.set('failed');
        },
      });
  }

  // ---- documents ----------------------------------------------------------
  protected documentFor(documentTypeId: number): RequestDocument | undefined {
    // Newest version wins — an upload never overwrites, it adds a version.
    return this.uploaded()
      .filter((d) => d.documentTypeId === documentTypeId)
      .sort((a, b) => b.version - a.version)[0];
  }

  protected onFile(event: Event, documentType: DocumentType): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    // Clear the input immediately, so choosing the same file again after a
    // failure still fires a change event.
    input.value = '';

    const requestId = this.requestId();

    if (!requestId) {
      this.toast.error('Fill in the school name first — the upload needs something to attach to.');
      return;
    }

    this.uploading.set(documentType.id);

    this.registration.upload(requestId, documentType.id, file).subscribe({
      next: () => {
        this.uploading.set(null);
        this.toast.success(`${documentType.name} uploaded.`);
        this.refreshDocuments();
      },
      error: () => {
        /*
          🔴 The other files stay.

          A failed upload that cleared the list would mean re-uploading four
          documents because the fifth was too large. The API has already said
          why in a toast — its message, not a second client-side rule that can
          disagree with it.
        */
        this.uploading.set(null);
      },
    });
  }

  private refreshDocuments(): void {
    const requestId = this.requestId();
    if (!requestId) return;

    this.registration.getById(requestId).subscribe({
      next: (detail) => this.uploaded.set(detail.documents),
      error: () => undefined,
    });
  }

  // ---- submit -------------------------------------------------------------
  protected submit(): void {
    const requestId = this.requestId();

    if (!requestId || this.submitting()) {
      return;
    }

    /*
      🔴 The button disables on click even though the server is idempotent.

      Submitting twice returns the existing request rather than creating a
      second (2.46) — but a person who double-clicks and watches two spinners
      does not care that the backend coped. They think they have sent it twice.
    */
    this.submitting.set(true);

    this.registration.submitDraft(requestId).subscribe({
      next: (result) => {
        this.submitting.set(false);

        // Straight to the status page. A bare confirmation screen leaves
        // somebody who has just handed over their documents with nowhere to go
        // and nothing to look at.
        void this.router.navigate(['/account/status'], {
          queryParams: { submitted: result.requestNo },
        });
      },
      error: () => this.submitting.set(false),
    });
  }

  // ---- review helpers -----------------------------------------------------
  protected lookupName(list: Lookup[], id: number | null | undefined): string {
    if (id === null || id === undefined) return '—';

    return list.find((l) => l.id === id)?.name ?? `#${id}`;
  }

  protected readonly stepKeys = STEPS;
}
