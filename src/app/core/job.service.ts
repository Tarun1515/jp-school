import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG } from 'jp-shared/core';
import { Observable, map } from 'rxjs';

/**
 * Jobs, over HTTP.
 *
 * ----------------------------------------------------------------------------
 * 🔴 NOTHING HERE SENDS A SchoolId — there is no field for one
 * ----------------------------------------------------------------------------
 * The server resolves the school from the token's OrganizationUid on every
 * request (2.39). It never comes back in a response either, so there is nothing
 * to cache and nothing to send.
 *
 * ⚠️ `branchId` DOES travel, because a job belongs to a campus the user picks.
 * That is legitimate data AND an authorization input, and only the server's
 * validation tells them apart — a campus the caller does not hold answers 404.
 * Never treat a branchId the client holds as proof of anything.
 */

/** Stored statuses. ⚠️ Expired (3) is derived by the server, never stored. */
export const JOB_STATUS = {
  draft: 1,
  active: 2,
  expired: 3,
  closed: 4,
} as const;

export interface JobListItem {
  jobId: number;
  jobUid: string;
  branchId: number;
  branchName: string;
  jobTitle: string;
  subjectId: number;
  designationId: number;
  employmentTypeId: number;
  noOfVacancies: number;
  salaryMin: number | null;
  salaryMax: number | null;
  isSalaryNegotiable: boolean;
  lastDateToApply: string | null;
  publishedOn: string | null;
  closedOn: string | null;
  viewCount: number;
  applicationCount: number;
  rowVersion: number;

  /**
   * 🔴 What the job EFFECTIVELY is right now.
   *
   * An Active job past its closing date reads 3 (Expired) here while
   * `storedStatusId` still reads 2 (Active). Both are sent so the screen can
   * show the truth AND say why it differs, rather than implying a process ran.
   */
  jobStatusId: number;

  /** What the database row literally holds. */
  storedStatusId: number;

  statusName: string;
  storedStatusName: string;

  /** 🔴 Arrives through an alias in the procedure (2.61). */
  isActive: boolean;
}

export interface JobDetail extends JobListItem {
  qualificationId: number | null;
  minExperienceMonths: number | null;
  maxExperienceMonths: number | null;
  cityId: number | null;
  stateId: number | null;
  workingDays: string | null;
  timingFrom: string | null;
  timingTo: string | null;
  expectedJoiningDate: string | null;
  jobDescription: string | null;
  subjectIds: number[];
  classLevelIds: number[];

  /**
   * Whether the matching fields are locked.
   *
   * ⚠️ Presentation only. The server enforces the lock and will refuse a
   * changed subject with JOB_FIELD_LOCKED regardless of what this says. It
   * exists so the form can grey the fields out instead of letting somebody fill
   * them in and then be refused.
   */
  structuralFieldsLocked: boolean;
}

export interface SaveJobBody {
  jobId?: number | null;
  branchId: number;
  jobTitle: string;
  subjectId: number;
  designationId: number;
  qualificationId?: number | null;
  employmentTypeId: number;
  noOfVacancies: number;
  minExperienceMonths?: number | null;
  maxExperienceMonths?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  isSalaryNegotiable: boolean;
  cityId?: number | null;
  stateId?: number | null;
  workingDays?: string | null;
  timingFrom?: string | null;
  timingTo?: string | null;
  lastDateToApply?: string | null;
  expectedJoiningDate?: string | null;
  jobDescription?: string | null;
  subjectIds: number[];
  classLevelIds: number[];
  rowVersion?: number | null;
}

export interface PublishResult {
  jobId: number;
  jobStatusId: number;

  /** True only when the plan was actually charged. */
  consumed: boolean;

  /** 1 = plan quota, 2 = credits. */
  source: number | null;
  entryId: number | null;

  /**
   * ⚠️ Can be set on a SUCCESS. `ALREADY_CONSUMED` means the job was published
   * and nothing was charged, because this job had been paid for before.
   */
  code: string | null;
}

export interface RecentJob {
  jobId: number;
  jobUid: string;
  jobTitle: string;
  branchName: string;
  lastDateToApply: string | null;
  publishedOn: string | null;
  noOfVacancies: number;
  jobStatusId: number;
  statusName: string;
}

export interface JobStats {
  totalJobs: number;
  draftCount: number;
  activeCount: number;
  expiredCount: number;
  closedCount: number;
  recent: RecentJob[];
}

interface Envelope<T> {
  status: number;
  code: string | null;
  message: string;
  data: T;
}

@Injectable({ providedIn: 'root' })
export class JobService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly baseUrl = `${this.api.appApiUrl}/jobs`;

  /**
   * The school's own jobs.
   *
   * ⚠️ `statusId` filters on the EFFECTIVE status, so asking for Expired
   * returns rows the database still stores as Active. That is the server's
   * derivation, not a client-side filter — a browser with a wrong clock must
   * not be able to disagree with the list about which jobs are open.
   */
  list(statusId?: number | null): Observable<JobListItem[]> {
    let params = new HttpParams();
    if (statusId) params = params.set('statusId', statusId);

    return this.http
      .get<Envelope<JobListItem[]>>(this.baseUrl, { params })
      .pipe(map((r) => r.data));
  }

  get(jobId: number): Observable<JobDetail> {
    return this.http
      .get<Envelope<JobDetail>>(`${this.baseUrl}/${jobId}`)
      .pipe(map((r) => r.data));
  }

  save(body: SaveJobBody): Observable<number> {
    return this.http.post<Envelope<number>>(this.baseUrl, body).pipe(map((r) => r.data));
  }

  /**
   * Publish — which is the action that spends the plan's allowance.
   *
   * 🔴 There is no "may I publish?" call, deliberately. Asking and acting in
   * two round trips lets two sessions both be told yes for the same last unit.
   * The server decides and records in one transaction; a refusal comes back as
   * a non-2xx carrying its own code.
   */
  publish(jobId: number): Observable<PublishResult> {
    return this.http
      .post<Envelope<PublishResult>>(`${this.baseUrl}/${jobId}/publish`, {})
      .pipe(map((r) => r.data));
  }

  close(jobId: number): Observable<void> {
    return this.http
      .post<Envelope<unknown>>(`${this.baseUrl}/${jobId}/close`, {})
      .pipe(map(() => undefined));
  }

  /**
   * The dashboard's counts.
   *
   * 🔴 No parameters — the server resolves the school from the token. There is
   * deliberately nothing here to point at somebody else's school.
   */
  stats(): Observable<JobStats> {
    return this.http
      .get<Envelope<JobStats>>(`${this.baseUrl}/stats`)
      .pipe(map((r) => r.data));
  }
}

/**
 * The refusal codes this feature can produce, as sentences a person can act on.
 *
 * ----------------------------------------------------------------------------
 * 🔴 QUOTA_EXHAUSTED IS NOT "SOMETHING WENT WRONG"
 * ----------------------------------------------------------------------------
 * It is a fact about the plan, and the person needs to know three things: that
 * the limit is reached, that it is a MONTHLY limit, and that the job is safe as
 * a draft. A generic error toast would send them to support for something that
 * is working exactly as sold.
 *
 * ⚠️ NO UPGRADE BUTTON. Purchase screens are Phase 6.5 and nothing can be
 * bought yet — a "Upgrade now" that leads nowhere is worse than no button. The
 * message states the fact and when the window resets.
 */
export function jobRefusalMessage(code: string | null | undefined, fallback: string): string {
  switch (code) {
    case 'QUOTA_EXHAUSTED':
      return 'You have used all the job posts your plan includes this month. '
        + 'The allowance resets on the 1st. Your job is saved as a draft until then.';

    case 'PLAN_LACKS_FEATURE':
      return 'Your plan does not include posting jobs. Your job is saved as a draft.';

    case 'FEATURE_DISABLED':
      return 'Job posting is switched off at the moment. Your job is saved as a draft — '
        + 'please try again shortly.';

    case 'SUBSCRIPTION_INACTIVE':
      return 'Your subscription is not active, so jobs cannot be published. Please contact us.';

    case 'SUBSCRIPTION_MISSING':
      return 'We could not find a plan on your account. Please contact us — this one is ours to fix.';

    case 'LAST_DATE_IN_PAST':
      return 'The closing date has already passed. Change it, then publish.';

    case 'JOB_FIELD_LOCKED':
      return 'A published job\'s campus, subject, designation, qualification, employment type, '
        + 'location and experience range cannot be changed. Close it and post a new one instead.';

    case 'CONSUME_CONFLICT':
    case 'PLAN_CHANGED':
      return 'That clashed with another change. Please try again.';

    default:
      return fallback;
  }
}

/**
 * Validation codes, mapped to the FIELD each one belongs to.
 *
 * 🔴 A field-level message, not one toast. "Please check your input" makes the
 * person hunt; naming the field is the difference between a two-second fix and
 * a support call. The server produces a distinct code per rule precisely so
 * this mapping is possible (2.12).
 */
export const JOB_FIELD_ERRORS: Record<string, { field: string; message: string }> = {
  JOB_TITLE_REQUIRED: { field: 'jobTitle', message: 'A job needs a title.' },
  INVALID_VACANCIES: { field: 'noOfVacancies', message: 'There must be at least one vacancy.' },
  INVALID_SALARY_RANGE: { field: 'salaryMax', message: 'The maximum salary is below the minimum.' },
  INVALID_EXPERIENCE_RANGE: {
    field: 'maxExperienceMonths',
    message: 'The maximum experience is below the minimum.',
  },
  LAST_DATE_IN_PAST: { field: 'lastDateToApply', message: 'That date has already passed.' },
};
