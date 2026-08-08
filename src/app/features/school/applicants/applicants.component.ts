import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { APPLICATION_STAGES, UiRollComponent } from '@tarun1515/jp-shared';
import { Applicant, SAMPLE_APPLICANTS } from './applicant.data';

const PAGE_SIZE = 15;

/**
 * Applicants — the dense screen the whole design direction had to survive.
 *
 * 50 rows, 8 columns, a filter bar and a pager, read at 1440px by someone in
 * their fourth hour. Three things carry that load:
 *
 *   THE MARGIN RULE lets the eye triage before it reads. Red means this one has
 *   been waiting on the school for more than a week; amber means it is mid
 *   interview; green means hired. The row ALSO says so in words — the colour is
 *   reinforcement, never the only carrier.
 *
 *   THE ROLL turns the stage column into a shape. Fifty pills have to be read
 *   one at a time; fifty rolls are a histogram, and the wall everyone is stuck
 *   behind is visible without reading anything.
 *
 *   THE RULING replaces zebra striping. Stripes track a row across but destroy
 *   the column, and after an hour they shimmer.
 *
 * ⚠️ Rows come from a fixture, not an API — see applicant.data.ts. Sorting and
 * paging are done here for the same reason; when JP.App.Api lands both move to
 * the server, exactly as ui-table already expects.
 */
@Component({
  selector: 'app-applicants',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, UiRollComponent],
  templateUrl: './applicants.component.html',
  styleUrl: './applicants.component.scss',
})
export class ApplicantsComponent {
  protected readonly stages = APPLICATION_STAGES;

  protected readonly search = signal('');
  protected readonly subject = signal('');
  protected readonly stage = signal('');
  protected readonly waitingOnly = signal(false);
  protected readonly page = signal(1);

  protected readonly subjects = [...new Set(SAMPLE_APPLICANTS.map((a) => a.subject))].sort();

  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const subject = this.subject();
    const stage = this.stage();
    const waitingOnly = this.waitingOnly();

    return SAMPLE_APPLICANTS.filter((applicant) => {
      if (term && !`${applicant.name} ${applicant.role}`.toLowerCase().includes(term)) {
        return false;
      }

      if (subject && applicant.subject !== subject) {
        return false;
      }

      if (stage && String(applicant.stage) !== stage) {
        return false;
      }

      if (waitingOnly && !this.needsReply(applicant)) {
        return false;
      }

      return true;
    });
  });

  protected readonly total = computed(() => this.filtered().length);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / PAGE_SIZE)),
  );

  protected readonly rows = computed(() => {
    const start = (this.page() - 1) * PAGE_SIZE;

    return this.filtered().slice(start, start + PAGE_SIZE);
  });

  protected readonly rangeStart = computed(() =>
    this.total() === 0 ? 0 : (this.page() - 1) * PAGE_SIZE + 1,
  );

  protected readonly rangeEnd = computed(() =>
    Math.min(this.page() * PAGE_SIZE, this.total()),
  );

  /** How many need the school to do something. Drives the count in the toolbar. */
  protected readonly waitingCount = computed(
    () => SAMPLE_APPLICANTS.filter((a) => this.needsReply(a)).length,
  );

  /**
   * An application sitting with the school for more than a week without moving
   * past Viewed. This is the number a head of HR is accountable for, so it is
   * the one thing the margin rule shouts about.
   */
  protected needsReply(applicant: Applicant): boolean {
    return !applicant.closed && applicant.stage <= 2 && applicant.waitingDays >= 7;
  }

  /*
    ONE HIERARCHY, HELD.

    An earlier version had three encodings running at once — an amber bar, a red
    status, and a grey "Closed" — and the eye could not tell which to read
    first. Three signals competing is the same as none.

    So each channel now says exactly one thing:

      the bar     STAGE, and only stage. Never red, never struck. It is the
                  shape you scan the column for; colouring it by urgency turns
                  the histogram into noise.
      the margin  ATTENTION. Red when a row needs the school to act, nothing
                  otherwise. One colour, one meaning.
      the status  the same attention, in words — because the margin rule is 3px
                  of colour and cannot be the only carrier.
      a mute      a closed row recedes as a whole, rather than the bar being
                  struck through. A struck bar is unreadable at a glance, which
                  is the one thing the bar exists to be.
  */

  protected rowState(applicant: Applicant): string {
    if (applicant.closed) return 'row--muted';
    if (this.needsReply(applicant)) return 'row--attention';

    return '';
  }

  /** The words that go with the margin rule, so the colour is never alone. */
  protected rowStateLabel(applicant: Applicant): string {
    if (applicant.closed) return 'Closed';
    if (this.needsReply(applicant)) return `Waiting ${applicant.waitingDays} days`;

    return APPLICATION_STAGES[Math.max(0, applicant.stage - 1)].label;
  }

  protected onFilterChange(): void {
    // Any filter change returns to page 1 — staying on page 4 of a result set
    // that now has two pages shows an empty table and reads as a bug.
    this.page.set(1);
  }

  protected clearFilters(): void {
    this.search.set('');
    this.subject.set('');
    this.stage.set('');
    this.waitingOnly.set(false);
    this.page.set(1);
  }

  protected readonly hasFilters = computed(
    () => !!this.search() || !!this.subject() || !!this.stage() || this.waitingOnly(),
  );

  protected goToPage(page: number): void {
    this.page.set(Math.max(1, Math.min(page, this.totalPages())));
  }

  protected readonly pageNumbers = computed(() => {
    const total = this.totalPages();

    return Array.from({ length: total }, (_, i) => i + 1);
  });
}
