import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService, ConfirmDialogService, ToastService } from 'jp-shared/core';
import { UiBadgeComponent, UiButtonComponent, UiEmptyStateComponent } from 'jp-shared/ui';

import { JOB_STATUS, JobListItem, JobService, jobRefusalMessage } from '../../../../core/job.service';

/** The tabs, in the order somebody works through them. */
const FILTERS = [
  { id: null, label: 'All' },
  { id: JOB_STATUS.draft, label: 'Drafts' },
  { id: JOB_STATUS.active, label: 'Active' },
  { id: JOB_STATUS.expired, label: 'Expired' },
  { id: JOB_STATUS.closed, label: 'Closed' },
] as const;

/**
 * The school's jobs.
 *
 * ----------------------------------------------------------------------------
 * 🔴 EXPIRED IS SHOWN, AND IT IS SHOWN AS DERIVED
 * ----------------------------------------------------------------------------
 * An Active job past its closing date arrives with `jobStatusId = 3` and
 * `storedStatusId = 2`. Both come from the server; the browser never compares
 * dates itself, because a machine with a wrong clock would then disagree with
 * the server about which jobs are open.
 *
 * The difference is shown, but QUIETLY: the badge says Expired, and a muted
 * note beside it says the posting is still live and the date is what passed.
 * Two equally loud badges would make somebody think there are two statuses to
 * reconcile. There is one status and one reason for it.
 *
 * ----------------------------------------------------------------------------
 * 🔴 NOT ALLOWED MEANS ABSENT (the 3F/3G rule)
 * ----------------------------------------------------------------------------
 * A user without JOB.PUBLISH does not get a greyed-out Publish button — they
 * get no Publish button. A disabled control reads as "broken" or as "try
 * again", and both are wrong: the answer is never going to change for them.
 *
 * ⚠️ The seed decides. HR holds JOB.CREATE and JOB.EDIT and not JOB.PUBLISH or
 * JOB.CLOSE, so an HR sees New job and Edit and neither of the other two. The
 * UI reads the permission; it does not have an opinion about the role.
 *
 * And hiding is not protecting: the server refuses the same action with 403
 * whether or not the button was drawn.
 */
@Component({
  selector: 'app-job-list',
  standalone: true,
  imports: [RouterLink, DatePipe, UiBadgeComponent, UiButtonComponent, UiEmptyStateComponent],
  templateUrl: './job-list.component.html',
  styleUrl: './job-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobListComponent {
  private readonly jobs = inject(JobService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly router = inject(Router);

  protected readonly FILTERS = FILTERS;
  protected readonly STATUS = JOB_STATUS;

  protected readonly rows = signal<JobListItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly filter = signal<number | null>(null);
  protected readonly busy = signal<number | null>(null);

  // The seed decides; the UI obeys.
  protected readonly canCreate = computed(() => this.auth.hasPermission('JOB.CREATE'));
  protected readonly canEdit = computed(() => this.auth.hasPermission('JOB.EDIT'));
  protected readonly canPublish = computed(() => this.auth.hasPermission('JOB.PUBLISH'));
  protected readonly canClose = computed(() => this.auth.hasPermission('JOB.CLOSE'));

  /**
   * True for a Viewer — someone who may read and change nothing.
   * Used for one honest line at the top, not to hide the list.
   */
  protected readonly readOnly = computed(() => !this.canCreate() && !this.canEdit());

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.failed.set(false);

    this.jobs.list(this.filter()).subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.failed.set(true);
        this.toast.error('Your jobs could not be loaded.');
      },
    });
  }

  protected setFilter(id: number | null): void {
    this.filter.set(id);
    this.load();
  }

  /** A published job whose closing date has passed. */
  protected isDerivedExpired(row: JobListItem): boolean {
    return row.jobStatusId === JOB_STATUS.expired && row.storedStatusId === JOB_STATUS.active;
  }

  protected badgeTone(row: JobListItem): 'success' | 'warning' | 'neutral' | 'danger' {
    switch (row.jobStatusId) {
      case JOB_STATUS.active: return 'success';
      case JOB_STATUS.expired: return 'warning';
      case JOB_STATUS.draft: return 'neutral';
      default: return 'danger';
    }
  }

  protected canPublishRow(row: JobListItem): boolean {
    // Publishable while it is a Draft. An Active or Expired job is already out.
    return this.canPublish() && row.storedStatusId === JOB_STATUS.draft;
  }

  protected canCloseRow(row: JobListItem): boolean {
    // ⚠️ Expired jobs ARE closeable — the row is still Active and only the date
    // has passed. Refusing that would leave a list nobody could tidy.
    return this.canClose() && row.storedStatusId === JOB_STATUS.active;
  }

  protected edit(row: JobListItem): void {
    this.router.navigate(['/jobs', row.jobId]);
  }

  protected publish(row: JobListItem): void {
    this.busy.set(row.jobId);

    this.jobs.publish(row.jobId).subscribe({
      next: (result) => {
        this.busy.set(null);
        this.load();

        /*
          ⚠️ ALREADY_CONSUMED is a SUCCESS. Re-publishing a job that was closed
          costs nothing, and saying so is better than silence — the person is
          about to wonder whether they were charged twice.
        */
        this.toast.success(
          result.code === 'ALREADY_CONSUMED'
            ? 'Published again. This job was already paid for, so nothing was charged.'
            : result.consumed
              ? 'Published. One job post used from your plan.'
              : 'Published.',
        );
      },
      error: (err) => {
        this.busy.set(null);
        this.load();

        /*
          🔴 The refusal gets its own sentence.

          QUOTA_EXHAUSTED is not a failure of the system — it is the plan
          working as sold, and the person needs to know the job is safe as a
          draft. A generic "something went wrong" sends them to support.
        */
        const code = err?.error?.code ?? null;

        this.toast.error(jobRefusalMessage(code, 'That job could not be published.'));
      },
    });
  }

  protected async closeJob(row: JobListItem): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Close this job?',
      message: `"${row.jobTitle}" will stop accepting applications. `
        + 'You can publish it again later, and re-publishing a job you have already paid for is free.',
      confirmText: 'Close job',
      danger: true,
    });

    if (!ok) return;

    this.busy.set(row.jobId);

    this.jobs.close(row.jobId).subscribe({
      next: () => {
        this.busy.set(null);
        this.load();
        this.toast.success('Closed.');
      },
      error: (err) => {
        this.busy.set(null);
        this.toast.error(jobRefusalMessage(err?.error?.code, 'That job could not be closed.'));
      },
    });
  }
}
