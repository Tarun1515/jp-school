import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiBadgeComponent, UiButtonComponent, UiEmptyStateComponent } from 'jp-shared/ui';

import { DashboardService, SchoolDashboard } from '../../../core/dashboard.service';

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
 * plan, its team. Jobs and applicants are empty states that say what the
 * section will be.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ NO ZERO, EITHER
 * ----------------------------------------------------------------------------
 * "0 open jobs" is not the honest version of a mockup — it is a measurement,
 * and there is nothing to measure: t_app_jobs does not exist until Phase 4. A
 * zero would be indistinguishable from a school that has posted nothing, and
 * the day the table lands nobody would know which screens had been lying.
 *
 * So the areas carry a disabled action and one line about when they arrive.
 * That is the ONE place in this product where a disabled control is right:
 * "not yet" is a fact about the product, where "not allowed" would be a fact
 * about the person and gets the other treatment (see UiEmptyStateComponent).
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

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly data = signal<SchoolDashboard | null>(null);

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
  }

  protected displayName(member: { fullName: string | null; email: string }): string {
    return member.fullName?.trim() || member.email;
  }

  protected readonly skeletonTiles = [0, 1, 2];
}
