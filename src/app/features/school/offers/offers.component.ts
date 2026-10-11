import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, MasterService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiBadgeComponent, UiEmptyStateComponent } from 'jp-shared/ui';

import { ApplicantListItem, ApplicantService } from '../../../core/applicant.service';

/**
 * The school's offers — candidates at an offer stage.
 *
 * ----------------------------------------------------------------------------
 * 🔴 WHY THIS IS THE APPLICANTS ENDPOINT AND NOT A NEW ONE
 * ----------------------------------------------------------------------------
 * There is no school-wide "list my offers" procedure, and 6C-2 did not add one,
 * because the question a school actually asks here is "who is at an offer
 * stage" — which is the applicant list with a status filter. 6A made stages
 * 7..10 reachable and flipped their IsReachable flag, so `application-status`
 * serves all ten and this filter is expressible with what already exists.
 *
 * ⚠️ The ACTIONS are deliberately not here. Sending, withdrawing and confirming
 * a hire all live on the applicant detail, where the candidate, their resume
 * and the offer history are in front of you. A list is where you decide who to
 * open; it is a bad place to commit to a salary.
 *
 * ----------------------------------------------------------------------------
 * 🔴 TWO MACHINES, AND THIS SCREEN SHOWS THE CANDIDATE'S
 * ----------------------------------------------------------------------------
 * 2.73: the stage names here ("Offer sent", "Offer accepted", "Hired") are the
 * APPLICATION's. The offer document's own status lives on the detail screen
 * beside the offer. Showing both on one row would invite them to disagree.
 */
@Component({
  selector: 'app-school-offers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, UiBadgeComponent, UiEmptyStateComponent],
  templateUrl: './offers.component.html',
  styleUrl: './offers.component.scss',
})
export class OffersComponent {
  private readonly applicants = inject(ApplicantService);
  private readonly masters = inject(MasterService);
  private readonly auth = inject(AuthService);

  protected readonly rows = signal<ApplicantListItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly stages = signal<Lookup[]>([]);

  /**
   * The offer chain's stages, from the master rather than written here.
   *
   * ⚠️ 2.47: master ids are the contract. These four are the stages an offer
   * produces (7 OfferSent, 8 OfferAccepted, 9 OfferDeclined, 10 Hired), and
   * reading their NAMES from the master is what keeps this screen's wording in
   * step with the applicant list's.
   */
  private readonly OFFER_STAGES = [7, 8, 9, 10];

  protected readonly stageName = computed(() => {
    const map = new Map(this.stages().map((s) => [s.id, s.name]));

    return (id: number) => map.get(id) ?? '';
  });

  protected readonly canSeeDetail = computed(() => this.auth.hasPermission('APPLICANT.VIEW'));

  /** Grouped, because "waiting on them" and "done" are different questions. */
  protected readonly awaiting = computed(() => this.rows().filter((r) => r.applicationStatusId === 7));
  protected readonly accepted = computed(() => this.rows().filter((r) => r.applicationStatusId === 8));
  protected readonly closed = computed(() =>
    this.rows().filter((r) => r.applicationStatusId === 9 || r.applicationStatusId === 10));

  constructor() {
    this.masters.get(MASTER_KEYS.applicationStatus).subscribe((v) => this.stages.set(v));
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.failed.set(false);

    /*
      ⚠️ FOUR REQUESTS, ONE PER STAGE, because the list endpoint takes a single
      statusId. That is honest about what exists rather than inventing a
      comma-separated filter the procedure does not accept — and four small
      reads on a screen somebody opens deliberately is not a problem worth a
      new endpoint.
    */
    let pending = this.OFFER_STAGES.length;
    const collected: ApplicantListItem[] = [];
    let anyFailed = false;

    for (const statusId of this.OFFER_STAGES) {
      this.applicants.list({ statusId }).subscribe({
        next: (rows) => {
          collected.push(...rows);
        },
        error: () => {
          anyFailed = true;
        },
        complete: () => {
          pending -= 1;

          if (pending === 0) {
            /*
              🔴 A PARTIAL FAILURE IS A FAILURE. Three stages answering and one
              dropping would render a list missing everybody at that stage —
              and the screen would look complete. So one failure fails the
              whole read.
            */
            if (anyFailed) {
              this.rows.set([]);
              this.failed.set(true);
            } else {
              collected.sort((a, b) => b.appliedOn.localeCompare(a.appliedOn));
              this.rows.set(collected);
            }

            this.loading.set(false);
          }
        },
      });
    }
  }

  /** The badge's tone, from the stage id — never the display text (2.21). */
  protected tone(statusId: number): 'info' | 'success' | 'neutral' {
    if (statusId === 8 || statusId === 10) return 'success';
    if (statusId === 7) return 'info';

    return 'neutral';
  }

  protected experience(months: number | null): string {
    if (months === null || months <= 0) return 'No experience recorded';

    const years = Math.floor(months / 12);

    return years === 0 ? `${months} months` : `${years} year${years === 1 ? '' : 's'}`;
  }
}
