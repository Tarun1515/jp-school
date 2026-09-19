import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiBadgeComponent, UiEmptyStateComponent, UiRollComponent, UiRollStage } from 'jp-shared/ui';

import {
  APPLICATION_STATUS,
  ApplicantListItem,
  ApplicantService,
} from '../../../../core/applicant.service';

/**
 * How many rows the SERVER returns at most (`USP_GetApplicantList` @Top).
 *
 * 🔴 Mirrored here ONLY to notice the cap, never to enforce it. When exactly
 * this many rows come back the list is probably truncated, and the screen says
 * so rather than quietly showing a subset as if it were everything.
 */
const SERVER_CAP = 200;

/** The mockup's page size, kept. Fifteen ruled rows is what the design proved. */
const PAGE_SIZE = 15;

/**
 * The school's applicants.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THIS SCREEN WAS A MOCKUP UNTIL TODAY, AND IT WAS THE CONVINCING ONE
 * ----------------------------------------------------------------------------
 * Phase 1D built it against fifty rows of fixture data with no HTTP call at
 * all (G6). 3I removed its route and hid its menu row rather than leave
 * something that fictional in front of a client, and kept the component under
 * `_design-reference/` for its DESIGN — the margin rule, the roll as a
 * histogram, ruling instead of zebra striping.
 *
 * This is that design against `t_app_applications`. The reference is deleted in
 * the same commit: it has done its job, and two applicant screens in one repo
 * is how the wrong one gets edited.
 *
 * ----------------------------------------------------------------------------
 * 🔴 ONE HIERARCHY, HELD — the reference's own rule, and it still applies
 * ----------------------------------------------------------------------------
 *   the roll    STAGE, and only stage. Never red, never struck.
 *   the margin  ATTENTION — this one is waiting on the school. One colour.
 *   the status  the same attention IN WORDS, because 3px of colour cannot be
 *               the only carrier of triage information.
 *   a mute      a finished row recedes as a whole.
 *
 * ⚠️ WHAT CHANGED FROM THE REFERENCE, AND WHY. It measured "waiting" from a
 * fixture's `waitingDays`. Nothing sends that, and computing it here from
 * `appliedOn` would put a DATE COMPARISON IN THE BROWSER — the same mistake the
 * jobs list refuses for expiry, where a machine with a wrong clock disagrees
 * with the server about the facts. So attention is derived from the STATUS
 * alone: an application still at Applied or Viewed is waiting on this school.
 * No clock, no drift, and it says the same thing.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE STAGES COME FROM THE MASTER, NOT FROM A CONSTANT (2.7)
 * ----------------------------------------------------------------------------
 * `APPLICATION_STAGES` in the design system is DECORATION — it draws the
 * pipeline on the sign-in shells, it lists seven stages including two the
 * product cannot reach yet, and it must not drive a data screen. The roll here
 * is built from `/api/masters/application-status`, which returns the six
 * REACHABLE statuses, so renaming one or adding one is a client-side data edit
 * with no deployment (2.7).
 *
 * ⚠️ Rejected is excluded from the TRACK, and by `code` rather than by id or
 * position — codes are the stable contract (2.47 / 2.21). It is not stage six
 * of six; it is leaving the track, and a histogram that marched to "Rejected"
 * as its finish line would read as progress.
 */
@Component({
  selector: 'app-applicant-list',
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    UiBadgeComponent,
    UiEmptyStateComponent,
    UiRollComponent,
  ],
  templateUrl: './applicant-list.component.html',
  styleUrl: './applicant-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplicantListComponent {
  private readonly applicants = inject(ApplicantService);
  private readonly masters = inject(MasterService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly STATUS = APPLICATION_STATUS;

  protected readonly rows = signal<ApplicantListItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  /** The six reachable statuses, from the master. Empty until they arrive. */
  protected readonly statuses = signal<Lookup[]>([]);

  // ---- filters -------------------------------------------------------------

  /**
   * Set from `?jobId=`, so "applicants for this job" is a LINK rather than a
   * second screen. Null means school-wide.
   *
   * ⚠️ Sent to the server, where it is applied AFTER the scope join — a job id
   * belonging to another school matches nothing rather than erroring, so there
   * is no id to probe with (2.6).
   */
  protected readonly jobId = signal<number | null>(null);

  /** Server-side. The procedure filters; this screen does not. */
  protected readonly statusId = signal<number | null>(null);

  /**
   * ⚠️ CLIENT-SIDE, over the rows already loaded, and the placeholder says so.
   * There is no search parameter on the endpoint, and a box that implied it
   * searched everything would be a lie the moment a school passed the cap.
   */
  protected readonly search = signal('');

  /** Client-side. Derived from status — see the header. */
  protected readonly waitingOnly = signal(false);

  protected readonly page = signal(1);

  constructor() {
    /*
      ⚠️ The query parameter is watched rather than read once: /applicants and
      /applicants?jobId=12 are the same component, and Angular reuses it. A
      one-shot read would leave the job filter stuck after navigating from a
      job's row back to the school-wide list.
    */
    this.route.queryParamMap.subscribe((params) => {
      const raw = params.get('jobId');
      const parsed = raw === null ? null : Number(raw);

      this.jobId.set(parsed !== null && Number.isFinite(parsed) ? parsed : null);
      this.page.set(1);
      this.load();
    });

    this.masters.get(MASTER_KEYS.applicationStatus).subscribe({
      next: (v) => this.statuses.set(v),

      // A filter that cannot be built is not a reason to hide the list.
      error: () => this.statuses.set([]),
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.failed.set(false);

    this.applicants.list({ jobId: this.jobId(), statusId: this.statusId() }).subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.rows.set([]);
        this.loading.set(false);
        this.failed.set(true);
        this.toast.error('Your applicants could not be loaded.');
      },
    });
  }

  // ---- the roll ------------------------------------------------------------

  /**
   * The progression, from the master, with the terminal status removed.
   *
   * 🔴 Excluded by CODE. Ids are contract too, but a code is what this codebase
   * branches on everywhere else and it survives the row being reordered.
   */
  protected readonly stages = computed<UiRollStage[]>(() =>
    this.statuses()
      .filter((s) => s.code !== 'REJECTED')
      .map((s) => ({ label: s.name })),
  );

  /** 1-based position on the track, or 0 for a row that has left it. */
  protected stageOf(row: ApplicantListItem): number {
    const index = this.statuses()
      .filter((s) => s.code !== 'REJECTED')
      .findIndex((s) => s.id === row.applicationStatusId);

    return index + 1;
  }

  protected isRejected(row: ApplicantListItem): boolean {
    return row.applicationStatusId === APPLICATION_STATUS.rejected;
  }

  // ---- the margin rule -----------------------------------------------------

  /** Waiting on the school: nobody has made a decision yet. */
  protected needsReply(row: ApplicantListItem): boolean {
    return (
      row.applicationStatusId === APPLICATION_STATUS.applied
      || row.applicationStatusId === APPLICATION_STATUS.viewed
    );
  }

  protected rowState(row: ApplicantListItem): string {
    if (this.isRejected(row)) return 'row--muted';
    if (this.needsReply(row)) return 'row--attention';

    return '';
  }

  /** The margin rule, in words. */
  protected rowStateLabel(row: ApplicantListItem): string {
    if (this.isRejected(row)) return 'Closed';
    if (this.needsReply(row)) return 'Needs your reply';

    return row.statusName;
  }

  protected readonly waitingCount = computed(
    () => this.rows().filter((r) => this.needsReply(r)).length,
  );

  // ---- filtering, paging ---------------------------------------------------

  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const waitingOnly = this.waitingOnly();

    return this.rows().filter((row) => {
      if (term && !`${row.teacherName} ${row.jobTitle}`.toLowerCase().includes(term)) return false;
      if (waitingOnly && !this.needsReply(row)) return false;

      return true;
    });
  });

  protected readonly total = computed(() => this.filtered().length);

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));

  protected readonly paged = computed(() => {
    const start = (this.page() - 1) * PAGE_SIZE;

    return this.filtered().slice(start, start + PAGE_SIZE);
  });

  protected readonly rangeStart = computed(() =>
    this.total() === 0 ? 0 : (this.page() - 1) * PAGE_SIZE + 1,
  );

  protected readonly rangeEnd = computed(() => Math.min(this.page() * PAGE_SIZE, this.total()));

  protected readonly pageNumbers = computed(() =>
    Array.from({ length: this.totalPages() }, (_, i) => i + 1),
  );

  /**
   * 🔴 The cap, said out loud.
   *
   * The procedure returns at most 200 rows. Showing 200 of 340 with no mention
   * of the other 140 is the failure mode a browse screen dies of quietly, and
   * a school making a hiring decision from it would never know.
   */
  protected readonly atServerCap = computed(() => this.rows().length >= SERVER_CAP);

  protected readonly hasFilters = computed(
    () => !!this.search() || this.statusId() !== null || this.waitingOnly(),
  );

  protected onStatusChange(value: number | null): void {
    this.statusId.set(value);
    this.page.set(1);

    // Server-side: this one goes back to the procedure.
    this.load();
  }

  protected onClientFilterChange(): void {
    this.page.set(1);
  }

  protected clearFilters(): void {
    this.search.set('');
    this.waitingOnly.set(false);
    this.statusId.set(null);
    this.page.set(1);
    this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(Math.max(1, Math.min(page, this.totalPages())));
  }

  protected open(row: ApplicantListItem): void {
    this.router.navigate(['/applicants', row.applicationId]);
  }

  protected experienceLabel(months: number | null): string {
    if (months === null || months <= 0) return '—';

    const years = Math.floor(months / 12);
    const rest = months % 12;

    if (years === 0) return `${rest}m`;
    if (rest === 0) return `${years}y`;

    return `${years}y ${rest}m`;
  }
}
