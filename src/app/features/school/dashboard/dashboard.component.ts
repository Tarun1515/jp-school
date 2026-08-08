import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APPLICATION_STAGES, UiRollComponent } from 'jp-shared/ui';
import { SAMPLE_APPLICANTS } from '../applicants/applicant.data';

/**
 * School dashboard.
 *
 * Answers the three questions a head of HR opens the product to ask, in the
 * order they ask them: what needs me today, where is everyone stuck, and who
 * came in overnight.
 *
 * The funnel tile is the roll at rest — the same seven stages, but counted
 * across every application rather than tracked for one. It is the clearest
 * demonstration of why the roll earns its place: the wall is visible without
 * reading a single number.
 *
 * ⚠️ Figures come from the applicants fixture. JP.App.Api is Phase 2.
 */
@Component({
  selector: 'app-school-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, UiRollComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class SchoolDashboardComponent {
  protected readonly stages = APPLICATION_STAGES;

  protected readonly needsReply = computed(
    () => SAMPLE_APPLICANTS.filter((a) => !a.closed && a.stage <= 2 && a.waitingDays >= 7).length,
  );

  protected readonly totalApplicants = SAMPLE_APPLICANTS.length;

  protected readonly interviews = computed(
    () => SAMPLE_APPLICANTS.filter((a) => !a.closed && a.stage === 4).length,
  );

  protected readonly hired = computed(
    () => SAMPLE_APPLICANTS.filter((a) => a.stage >= 7).length,
  );

  /** How many applications sit at each stage. The funnel, counted. */
  protected readonly funnel = computed(() =>
    APPLICATION_STAGES.map((stage, index) => {
      const count = SAMPLE_APPLICANTS.filter(
        (a) => !a.closed && a.stage === index + 1,
      ).length;

      return {
        label: stage.label,
        count,
        // Widths are relative to the busiest stage, not to the total: with a
        // realistic funnel the total-relative version leaves every bar after
        // the second one invisible.
        share: count,
      };
    }),
  );

  protected readonly funnelPeak = computed(() =>
    Math.max(1, ...this.funnel().map((entry) => entry.count)),
  );

  /**
   * The funnel counts open applications only, so its stages do not sum to the
   * total in the stat tile. Both numbers are stated rather than leaving the
   * reader to notice the gap and distrust one of them.
   */
  protected readonly openTotal = computed(() =>
    this.funnel().reduce((sum, entry) => sum + entry.count, 0),
  );

  protected readonly closedTotal = computed(
    () => SAMPLE_APPLICANTS.filter((a) => a.closed).length,
  );

  /** The most recent, for the "came in overnight" question. */
  protected readonly recent = computed(() =>
    [...SAMPLE_APPLICANTS]
      .sort((a, b) => b.appliedOn.localeCompare(a.appliedOn))
      .slice(0, 7),
  );

  /**
   * The open jobs, derived from what people have actually applied to.
   *
   * Added because the dashboard ended two panels up and left the bottom 40% of
   * a 1440px viewport blank. An empty lower half reads as a page that is not
   * finished, and the honest fix is the content that belongs there rather than
   * stretching two panels to cover it: after "what needs me" and "where is
   * everyone", the next question is "what are we actually hiring for".
   */
  protected readonly jobs = computed(() => {
    const byRole = new Map<string, { applicants: number; needsReply: number; subject: string }>();

    for (const applicant of SAMPLE_APPLICANTS) {
      const entry = byRole.get(applicant.role) ?? {
        applicants: 0,
        needsReply: 0,
        subject: applicant.subject,
      };

      entry.applicants += 1;

      if (!applicant.closed && applicant.stage <= 2 && applicant.waitingDays >= 7) {
        entry.needsReply += 1;
      }

      byRole.set(applicant.role, entry);
    }

    return [...byRole.entries()]
      .map(([role, entry]) => ({ role, ...entry }))
      .sort((a, b) => b.needsReply - a.needsReply || b.applicants - a.applicants);
  });
}
