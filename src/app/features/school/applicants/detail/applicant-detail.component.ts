import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import {
  UiBadgeComponent,
  UiEmptyStateComponent,
  UiRollComponent,
  UiRollStage,
} from 'jp-shared/ui';

import {
  APPLICATION_STATUS,
  AllowedTransition,
  ApplicantDetail,
  ApplicantService,
  applicantRefusalMessage,
} from '../../../../core/applicant.service';

/**
 * One applicant, in full. 🔒 THE CONTACT BOUNDARY IS ON THIS SCREEN.
 *
 * ----------------------------------------------------------------------------
 * 🔒 2.56, AND IT IS THE POINT OF THE WHOLE PHASE
 * ----------------------------------------------------------------------------
 * A teacher's email and mobile appear HERE and nowhere else in this app, and
 * only because `fn_TeacherContactUnlocked` said so. The screen does not decide:
 * `isContactUnlocked` arrives from the server and the block is not rendered
 * without it.
 *
 * ⚠️ NOT HIDDEN WITH CSS, AND NOT `*ngIf` OVER DATA THAT ARRIVED ANYWAY. When
 * the answer is no, the fields come back null — there is nothing in the
 * response to reveal with a devtools inspector, a "show hidden elements" click
 * or a saved HAR file. Before this phase there was no consent path at all and
 * the function returned a flat 0; an application IS consent path 1.
 *
 * ⚠️ A SUBSCRIPTION BUYS CAPABILITY, NEVER CONTACT. There is deliberately no
 * plan check, no entitlement call and no "unlock" button anywhere on this
 * screen, and none may be added: contact opens on the TEACHER's act, and only
 * theirs.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE RESUME IS THE SNAPSHOT, AND IT IS ALSO A CONTACT DETAIL
 * ----------------------------------------------------------------------------
 * `resumePathSnapshot` is the file as it was the moment they applied. A teacher
 * who replaces their CV tomorrow does not change what this school shortlisted.
 *
 * And it needs RESUME.DOWNLOAD on top of APPLICANT.VIEW, because a CV carries a
 * phone number and a home address. A school Viewer sees THAT a resume exists
 * and gets no button to open it — absent, not disabled, because the answer is
 * never going to change for them (2.62 / the 3F rule).
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE STATUS BUTTONS ARE THE SERVER'S ANSWER, NOT THIS FILE'S OPINION
 * ----------------------------------------------------------------------------
 * `allowedTransitions` is computed by `fn_ApplicationTransitionAllowed` — the
 * same function that refuses an illegal move. This component holds NO copy of
 * the map and must never grow one: two copies of a rule drift, and the drift
 * shows up as a button that produces an error.
 *
 * ⚠️ A Rejected application comes back with an empty list, so no buttons are
 * drawn at all. That is the correct rendering of a terminal state, not a
 * loading bug — the component must not treat empty as "unknown".
 *
 * Permissions narrow that further: rejecting needs APPLICANT.REJECT and every
 * other move needs APPLICANT.SHORTLIST. An HR holds the second and not the
 * first, so an HR can shortlist and cannot reject — and sees exactly that.
 */
@Component({
  selector: 'app-applicant-detail',
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    UiBadgeComponent,
    UiEmptyStateComponent,
    UiRollComponent,
  ],
  templateUrl: './applicant-detail.component.html',
  styleUrl: './applicant-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplicantDetailComponent {
  private readonly applicants = inject(ApplicantService);
  private readonly masters = inject(MasterService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly STATUS = APPLICATION_STATUS;

  protected readonly data = signal<ApplicantDetail | null>(null);
  protected readonly loading = signal(true);

  /** 🔴 404 and 403 land here identically — see {@link load}. */
  protected readonly notFound = signal(false);

  protected readonly busy = signal(false);
  protected readonly statuses = signal<Lookup[]>([]);

  /** Master data for the profile summary. Names, never ids, on screen (2.7). */
  protected readonly subjects = signal<Lookup[]>([]);
  protected readonly designations = signal<Lookup[]>([]);
  protected readonly qualifications = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);
  protected readonly states = signal<Lookup[]>([]);

  // ---- rejection ----------------------------------------------------------

  protected readonly rejecting = signal(false);
  protected readonly rejectionReason = signal('');

  // ---- permissions --------------------------------------------------------

  /** Every move except rejection. */
  protected readonly canShortlist = computed(() => this.auth.hasPermission('APPLICANT.SHORTLIST'));

  /** 🔴 Its own permission, deliberately. Rejecting is the irreversible one. */
  protected readonly canReject = computed(() => this.auth.hasPermission('APPLICANT.REJECT'));

  /** The resume is a contact detail, so it has a contact detail's permission. */
  protected readonly canDownloadResume = computed(() => this.auth.hasPermission('RESUME.DOWNLOAD'));

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('applicationId'));

      if (!Number.isFinite(id) || id <= 0) {
        this.notFound.set(true);
        this.loading.set(false);

        return;
      }

      this.load(id);
    });

    this.masters.get(MASTER_KEYS.applicationStatus).subscribe({
      next: (v) => this.statuses.set(v),
      error: () => this.statuses.set([]),
    });

    this.masters.get(MASTER_KEYS.subject).subscribe((v) => this.subjects.set(v));
    this.masters.get(MASTER_KEYS.designation).subscribe((v) => this.designations.set(v));
    this.masters.get(MASTER_KEYS.qualification).subscribe((v) => this.qualifications.set(v));
    this.masters.get(MASTER_KEYS.city).subscribe((v) => this.cities.set(v));
    this.masters.get(MASTER_KEYS.state).subscribe((v) => this.states.set(v));
  }

  /**
   * ⚠️ THIS READ WRITES, on the server. Opening an application stamps
   * Applied → Viewed and the response comes back already moved on — status,
   * `viewedOn`, the new history row and a fresh `allowedTransitions`. So the
   * screen renders WHAT CAME BACK and never what it asked for.
   */
  protected load(applicationId: number): void {
    this.loading.set(true);
    this.notFound.set(false);

    this.applicants.get(applicationId).subscribe({
      next: (detail) => {
        this.data.set(detail);
        this.loading.set(false);
      },
      error: () => {
        /*
          🔴 404 AND 403 ARE THE SAME SCREEN, on purpose.

          An application at another school — or at a campus this user is not
          bound to — answers 404 rather than 403, because "you may not see
          THAT one" confirms it exists (2.6). Rendering the two differently
          here would rebuild the oracle the API refuses to be.
        */
        this.data.set(null);
        this.notFound.set(true);
        this.loading.set(false);
      },
    });
  }

  // ---- the roll -----------------------------------------------------------

  protected readonly stages = computed<UiRollStage[]>(() =>
    this.statuses()
      .filter((s) => s.code !== 'REJECTED')
      .map((s) => ({ label: s.name })),
  );

  protected readonly currentStage = computed(() => {
    const detail = this.data();

    if (!detail) return 0;

    return (
      this.statuses()
        .filter((s) => s.code !== 'REJECTED')
        .findIndex((s) => s.id === detail.applicationStatusId) + 1
    );
  });

  protected readonly isRejected = computed(
    () => this.data()?.applicationStatusId === APPLICATION_STATUS.rejected,
  );

  // ---- what the person may actually do ------------------------------------

  /**
   * The server's legal moves, narrowed by what this user holds.
   *
   * 🔴 BOTH FILTERS, AND IN THIS ORDER. The server says what the APPLICATION
   * allows; the permission says what the PERSON allows. Either alone would draw
   * a button that produces a refusal.
   */
  protected readonly actions = computed<AllowedTransition[]>(() => {
    const detail = this.data();

    if (!detail) return [];

    return detail.allowedTransitions.filter((t) =>
      t.code === 'REJECTED' ? this.canReject() : this.canShortlist(),
    );
  });

  /**
   * True when the application can still move but this user may not move it.
   *
   * ⚠️ Used for ONE honest line, not to hide the screen. A Viewer reading an
   * applicant should understand why there are no buttons rather than wonder
   * whether the page finished loading.
   */
  protected readonly readOnly = computed(
    () => (this.data()?.allowedTransitions.length ?? 0) > 0 && this.actions().length === 0,
  );

  protected setStatus(transition: AllowedTransition): void {
    if (transition.code === 'REJECTED') {
      // Rejection gets a reason box first — see the template.
      this.rejecting.set(true);

      return;
    }

    this.apply(transition.applicationStatusId, null, `Moved to ${transition.name}.`);
  }

  protected confirmReject(): void {
    this.apply(
      APPLICATION_STATUS.rejected,
      this.rejectionReason().trim() || null,
      'Marked as not selected.',
    );
  }

  protected cancelReject(): void {
    this.rejecting.set(false);
    this.rejectionReason.set('');
  }

  private apply(toStatusId: number, remarks: string | null, success: string): void {
    const detail = this.data();

    if (!detail) return;

    this.busy.set(true);

    this.applicants.setStatus(detail.applicationId, toStatusId, remarks).subscribe({
      next: () => {
        this.busy.set(false);
        this.rejecting.set(false);
        this.rejectionReason.set('');
        this.toast.success(success);

        // Re-read: the history, the stage and the next legal moves all changed.
        this.load(detail.applicationId);
      },
      error: (err) => {
        this.busy.set(false);
        this.toast.error(
          applicantRefusalMessage(err?.error?.code, 'That change could not be saved.'),
        );

        // ⚠️ Re-read on failure too. INVALID_TRANSITION usually means a
        // colleague moved it while this page was open, and the screen must
        // stop showing the stale set of buttons that caused it.
        this.load(detail.applicationId);
      },
    });
  }

  // ---- the resume ---------------------------------------------------------

  protected openResume(): void {
    const detail = this.data();

    if (!detail) return;

    this.applicants.openResume(detail.applicationId).subscribe({
      next: (objectUrl) => {
        window.open(objectUrl, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      },
      error: () => this.toast.error('That resume could not be opened.'),
    });
  }

  // ---- display helpers ----------------------------------------------------

  protected name(list: Lookup[], id: number | null | undefined): string {
    if (id === null || id === undefined) return '—';

    return list.find((l) => l.id === id)?.name ?? '—';
  }

  protected experienceLabel(months: number | null): string {
    if (months === null || months <= 0) return 'Not stated';

    const years = Math.floor(months / 12);
    const rest = months % 12;

    if (years === 0) return `${rest} months`;
    if (rest === 0) return `${years} years`;

    return `${years} years ${rest} months`;
  }

  protected salaryLabel(min: number | null, max: number | null): string {
    if (min === null && max === null) return 'Not stated';
    if (min !== null && max !== null) return `₹${min.toLocaleString('en-IN')} – ₹${max.toLocaleString('en-IN')}`;

    const one = (min ?? max) as number;

    return `₹${one.toLocaleString('en-IN')}`;
  }

  /**
   * Who moved it.
   *
   * 🔴 "The applicant" when the server sent no name — the FIRST history row on
   * every application is written by the teacher, and the procedure deliberately
   * resolves names only through this school's own colleague list so that a
   * teacher's sign-in email can never leak through a fallback.
   */
  protected actorLabel(name: string | null): string {
    return name?.trim() || 'the applicant';
  }

  protected back(): void {
    this.router.navigate(['/applicants']);
  }
}
