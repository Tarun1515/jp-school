import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiBadgeComponent, UiButtonComponent, UiEmptyStateComponent } from 'jp-shared/ui';

import { DashboardService, SchoolDashboard } from '../../../core/dashboard.service';
import { JobService, JobStats } from '../../../core/job.service';

/**
 * The school dashboard.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THIS SCREEN USED TO BE A MOCKUP, AND IT WAS THE MOST CONVINCING ONE
 * ----------------------------------------------------------------------------
 * Every figure on it — 50 applicants, the funnel, "latest applications", open
 * jobs — was computed from `applicants/applicant.data.ts`. No HTTP call was
 * made at all. It was also the screen that looked the most finished, which is
 * the dangerous combination in front of a client (G6).
 *
 * What replaced it shows ONLY what exists: the school, its head office, its
 * plan, its team.
 *
 * ----------------------------------------------------------------------------
 * 🔴 PHASE 4B: THE JOBS AREA IS NOW REAL. APPLICANTS IS STILL NOT.
 * ----------------------------------------------------------------------------
 * 3I could not show a job count because t_app_jobs did not exist, and a zero
 * would have been a measurement of something unmeasurable — indistinguishable
 * from a school that had posted nothing.
 *
 * The table exists now, so the counts are a real measurement and a zero is a
 * real zero. The empty state changed its words to match: "You have not posted a
 * vacancy yet" is a fact about this school, where the old copy — "arrives in a
 * coming release" — was a fact about the product.
 *
 * ⚠️ THE APPLICANTS AREA IS UNTOUCHED, and that is deliberate.
 * t_app_applications is Phase 5. Its disabled action and "arrives after job
 * posting" note stay exactly as 3I wrote them, because they are still true —
 * and that is the ONE place a disabled control is right: "not yet" is a fact
 * about the product, where "not allowed" would be a fact about the person and
 * gets the other treatment (see UiEmptyStateComponent).
 */
@Component({
  selector: 'app-school-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, UiBadgeComponent, UiButtonComponent, UiEmptyStateComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class SchoolDashboardComponent {
  private readonly dashboards = inject(DashboardService);
  private readonly jobs = inject(JobService);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly data = signal<SchoolDashboard | null>(null);

  /**
   * The jobs area's real numbers (Phase 4B).
   *
   * ----------------------------------------------------------------------------
   * 🔴 THE COUNTING HAPPENS ON THE SERVER
   * ----------------------------------------------------------------------------
   * `GET /api/jobs/stats` returns the counts and the five most recent already
   * computed. The alternative — fetching every job and counting here — would
   * ship hundreds of rows to render four numbers, and would put the definition
   * of "expired" in the browser, where a machine with a wrong clock could
   * disagree with the jobs list about which jobs are open.
   *
   * Same rule 3I applied to `waitingDays`: the server measures, the screen
   * displays.
   *
   * ⚠️ A SEPARATE call from the dashboard's own, on purpose. The dashboard
   * endpoint composes school, team and plan; jobs are a different subsystem
   * with their own permission (JOB.VIEW), and folding them in would mean a
   * person without it either breaks the whole dashboard or silently gets a
   * partial one.
   */
  protected readonly jobStats = signal<JobStats | null>(null);

  protected readonly isMultiCampus = computed(() => this.data()?.groupType !== 1);

  /** How many colleagues have been invited but have never signed in (2.58). */
  protected readonly notArrived = computed(
    () => this.data()?.team.filter((m) => !m.hasArrived).length ?? 0,
  );

  /**
   * What the plan tile says.
   *
   * ⚠️ Three states, and the third is the one worth having: an account with no
   * subscription row. Provisioning is supposed to make one for everybody, and
   * 3B's repair left the possibility of an account without. Saying so is more
   * useful than a blank space, and far more useful than pretending it is free.
   */
  protected readonly planLine = computed(() => {
    const plan = this.data()?.plan;

    if (!plan?.hasSubscription) return 'No plan on file';
    if (!plan.isActive) return `${plan.planName ?? 'Your plan'} — not active`;

    return plan.planName ?? 'Your plan';
  });

  protected readonly planTone = computed<'success' | 'warning' | 'neutral'>(() => {
    const plan = this.data()?.plan;

    if (!plan?.hasSubscription) return 'warning';

    return plan.isActive ? 'success' : 'warning';
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);

    this.dashboards.getSchool().subscribe({
      next: (data) => {
        this.data.set(data);
        this.loading.set(false);
      },
      error: () => {
        // The interceptor has already said what went wrong. Clearing the data
        // matters more: a dashboard showing yesterday's figures under a failed
        // refresh is one somebody makes a decision from.
        this.data.set(null);
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });

    /*
      ⚠️ Its own call, and its own failure. A person who can see the dashboard
      but not jobs (no JOB.VIEW) gets a 403 here and the rest of the screen is
      unaffected — the jobs tile simply stays quiet rather than taking the whole
      page down with it.
    */
    this.jobs.stats().subscribe({
      next: (stats) => this.jobStats.set(stats),
      error: () => this.jobStats.set(null),
    });
  }

  protected displayName(member: { fullName: string | null; email: string }): string {
    return member.fullName?.trim() || member.email;
  }

  protected readonly skeletonTiles = [0, 1, 2];
}
