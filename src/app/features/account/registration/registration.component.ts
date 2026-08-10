import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MasterService, ToastService } from 'jp-shared/core';
import { DocumentType, Lookup, MASTER_KEYS, RequestDocument, SaveDraftBody } from 'jp-shared/models';

import { RegistrationService } from '../../../core/registration.service';

/** The steps, in order. `review` is last and is not editable. */
const STEPS = ['basics', 'address', 'contact', 'documents', 'review'] as const;
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
  { key: 'contact', label: 'Who to reach', hint: 'The people we contact about hiring.' },
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
 * Anything about price. Pricing is not finalised, the public FAQ says so, and
 * a number shown during registration is one we would be held to.
 */
@Component({
  selector: 'app-registration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './registration.component.html',
  styleUrl: './registration.component.scss',
})
export class RegistrationComponent {
  private readonly registration = inject(RegistrationService);
  private readonly masters = inject(MasterService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

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
    cityId: null,
  });

  // ---- masters ------------------------------------------------------------
  protected readonly boards = signal<Lookup[]>([]);
  protected readonly schoolTypes = signal<Lookup[]>([]);
  protected readonly states = signal<Lookup[]>([]);
  protected readonly districts = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);
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

  // ---- documents ----------------------------------------------------------
  protected readonly uploaded = signal<RequestDocument[]>([]);
  protected readonly uploading = signal<number | null>(null);

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
              principalName: d.principalName,
              principalMobile: d.principalMobile,
              hrContactName: d.hrContactName,
              hrContactMobile: d.hrContactMobile,
              contactEmail: d.contactEmail,
              contactMobile: d.contactMobile,
              website: d.website,
              aboutSchool: d.aboutSchool,
            });

            if (d.stateId) {
              this.loadDistricts(d.stateId);
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

  /**
   * State changed, so the district list has to be refetched — and city has to
   * be cleared, because a city under the old state is now wrong.
   */
  protected onStateChange(stateId: number | null): void {
    this.set('stateId', stateId);
    this.set('districtId', null);
    this.set('cityId', null);
    this.districts.set([]);
    this.cities.set([]);

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

  protected onDistrictChange(districtId: number | null): void {
    this.set('districtId', districtId);
    this.set('cityId', null);
    this.cities.set([]);

    if (districtId) {
      this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
        next: (items) => this.cities.set(items),
        error: () => this.cities.set([]),
      });
    }
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

    if (step === 'contact') {
      if (!f.contactEmail?.trim()) {
        errors['contactEmail'] = 'We send verification updates to this address.';
      }

      if (f.contactEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contactEmail.trim())) {
        errors['contactEmail'] = 'That email address does not look complete.';
      }

      for (const [key, label] of [
        ['contactMobile', 'contact'],
        ['principalMobile', "principal's"],
        ['hrContactMobile', "HR contact's"],
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
