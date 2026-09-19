import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG, SKIP_LOADER } from 'jp-shared/core';
import { Observable, map } from 'rxjs';

/**
 * The school's applicants, over HTTP.
 *
 * ----------------------------------------------------------------------------
 * 🔴 NOTHING HERE SENDS OR RECEIVES A SchoolId
 * ----------------------------------------------------------------------------
 * The server resolves the school from the token's OrganizationUid on every
 * request (2.39). A teacher is identified by `teacherUid`; there is no
 * `teacherId` on the wire either.
 *
 * ⚠️ `branchId` DOES travel as a filter, for the same reason it does on jobs:
 * it is legitimate data AND an authorization input, and only the server can
 * tell the two apart. A campus the caller does not hold simply matches nothing.
 *
 * ----------------------------------------------------------------------------
 * 🔴 CONTACT LIVES ON ONE SHAPE, AND IT IS NOT THE LIST
 * ----------------------------------------------------------------------------
 * {@link ApplicantListItem} has no email, no mobile and no resume path — not
 * nulled, ABSENT. Every applicant in that list has consented, so carrying them
 * would not break decision 2.56; it would break the SHAPE, and the shape is
 * what has held the line since 3D. A list is a browse surface that ends up in a
 * screenshot or an export. Contact is a deliberate act on one person, which is
 * {@link ApplicantDetail}.
 *
 * ⚠️ Do not add contact fields to the list interface "for convenience". The
 * procedure does not select them and the API does not send them.
 */

/** Stored application statuses. ⚠️ ids come from `m_app_application_status`. */
export const APPLICATION_STATUS = {
  applied: 1,
  viewed: 2,
  shortlisted: 3,
  interview: 4,
  selected: 5,
  rejected: 6,
} as const;

export interface ApplicantListItem {
  applicationId: number;
  applicationUid: string;

  jobId: number;
  jobTitle: string;
  subjectId: number;
  designationId: number;

  branchId: number;
  branchName: string;

  teacherUid: string;
  teacherName: string;
  photoPath: string | null;
  teacherDesignationId: number | null;
  teacherQualificationId: number | null;
  totalExperienceMonths: number | null;
  currentCityId: number | null;
  currentStateId: number | null;
  profileCompletionPercent: number;

  /**
   * The verified badge — a SIGNAL, never a gate (2.9, a locked stance).
   *
   * ⚠️ An unverified teacher can apply and does appear here. The badge tells a
   * school what has been checked; it must never be used to filter somebody out
   * of this list, and there is deliberately no "verified only" control.
   */
  isVerified: boolean;

  applicationStatusId: number;
  statusName: string;
  appliedOn: string;
  viewedOn: string | null;

  /** The FACT of a resume. The path is on the detail, and only when unlocked. */
  hasResume: boolean;
  hasCoverNote: boolean;

  rowVersion: number;

  /** 🔴 Arrives through an alias in the procedure (2.61). */
  isActive: boolean;
}

/** One step of the application's history, as the school sees it. */
export interface ApplicationHistoryStep {
  historyId: number;
  fromStatusId: number | null;
  fromStatusName: string | null;
  toStatusId: number;
  toStatusName: string;
  changedOn: string;
  changedByUserId: number | null;

  /**
   * 🔴 NULL for the teacher, on purpose.
   *
   * The first history row on every application is written by the TEACHER, and
   * the name is resolved only through this school's own colleague list. There
   * is no email fallback — one would hand the school the teacher's sign-in
   * address on every applicant, unlocked or not. The screen says "the
   * applicant" when this is null.
   */
  changedByName: string | null;

  remarks: string | null;
}

/**
 * A status this application may be moved to next.
 *
 * 🔴 COMES FROM THE SERVER, computed by `fn_ApplicationTransitionAllowed` —
 * the same function that refuses an illegal move. This file does NOT know the
 * map and must never learn it: a copy here would be a second source of truth
 * for a rule the database enforces, and the two would drift silently, with the
 * screen offering an action the server then refused.
 *
 * ⚠️ An EMPTY list is a real answer. A rejected application is terminal, so
 * nothing comes back and the screen draws no actions at all — a move that will
 * never be allowed is ABSENT, not disabled (the 3F/3G rule). Never read empty
 * as "unknown, offer everything".
 */
export interface AllowedTransition {
  applicationStatusId: number;

  /** 🔴 The stable contract. Branch on this, never on `name` (2.21 / 2.47). */
  code: string;

  /** The school's wording, editable by the client at any time. */
  name: string;

  displayOrder: number;
}

export interface ApplicantDetail {
  applicationId: number;
  applicationUid: string;

  jobId: number;
  jobTitle: string;
  subjectId: number;
  designationId: number;
  employmentTypeId: number;
  noOfVacancies: number;
  lastDateToApply: string | null;
  jobStatusId: number;

  branchId: number;
  branchName: string;

  teacherUid: string;
  teacherName: string;
  photoPath: string | null;
  genderId: number | null;
  teacherQualificationId: number | null;
  highestQualificationText: string | null;
  teacherDesignationId: number | null;
  totalExperienceMonths: number | null;
  currentSchool: string | null;
  lastSchool: string | null;
  expectedSalaryMin: number | null;
  expectedSalaryMax: number | null;
  currentCityId: number | null;
  currentStateId: number | null;
  aboutMe: string | null;
  isVerified: boolean;
  profileCompletionPercent: number;

  applicationStatusId: number;
  statusName: string;
  appliedOn: string;
  viewedOn: string | null;
  coverNote: string | null;

  /** The school's own note. 🔴 Never shown to the teacher — see 017's header. */
  rejectionReason: string | null;

  rowVersion: number;
  isActive: boolean;

  /**
   * 🔴 WHETHER `fn_TeacherContactUnlocked` SAID SO. Nothing else decides this.
   *
   * Present-and-null when locked, which is the opposite of the list's rule and
   * deliberate: here contact IS the purpose of the shape, so the fields are the
   * contract and this flag says whether they are real.
   */
  isContactUnlocked: boolean;
  contactEmail: string | null;
  contactMobile: string | null;

  /** 🔴 The resume AS IT WAS when they applied, never the teacher's current one. */
  resumePathSnapshot: string | null;
  hasResume: boolean;

  history: ApplicationHistoryStep[];
  allowedTransitions: AllowedTransition[];
}

export interface RecentApplicant {
  applicationId: number;
  applicationUid: string;
  jobId: number;
  jobTitle: string;
  branchName: string;
  teacherUid: string;
  teacherName: string;
  photoPath: string | null;
  isVerified: boolean;
  applicationStatusId: number;
  statusName: string;
  appliedOn: string;
  viewedOn: string | null;
}

export interface SchoolApplicantStats {
  totalApplications: number;
  newCount: number;
  viewedCount: number;
  shortlistedCount: number;
  interviewCount: number;
  selectedCount: number;
  rejectedCount: number;
  jobsWithApplicants: number;
  recent: RecentApplicant[];
}

interface Envelope<T> {
  status: number;
  code: string | null;
  message: string;
  data: T;
}

@Injectable({ providedIn: 'root' })
export class ApplicantService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly baseUrl = `${this.api.appApiUrl}/applicants`;

  /**
   * Everybody who has applied to this school, or one job's applicants.
   *
   * ⚠️ `jobId` omitted means school-wide. A job belonging to another school
   * matches nothing rather than erroring, because the scope join runs before
   * the filter — there is no id to probe with.
   */
  list(filter?: {
    jobId?: number | null;
    statusId?: number | null;
    branchId?: number | null;
  }): Observable<ApplicantListItem[]> {
    let params = new HttpParams();

    if (filter?.jobId) params = params.set('jobId', filter.jobId);
    if (filter?.statusId) params = params.set('statusId', filter.statusId);
    if (filter?.branchId) params = params.set('branchId', filter.branchId);

    return this.http
      .get<Envelope<ApplicantListItem[]>>(this.baseUrl, { params })
      .pipe(map((r) => r.data));
  }

  /**
   * One applicant, in full.
   *
   * 🔴 THIS READ WRITES, and that is deliberate: opening an application is how
   * a school "sees" it, and the teacher's own list says "Seen by the school" on
   * the strength of it. The server stamps Applied → Viewed and returns the
   * application as it now is — so the caller must render what comes back rather
   * than what it asked for. Making it a button would mean the flag reported
   * whether somebody remembered to press it.
   */
  get(applicationId: number): Observable<ApplicantDetail> {
    return this.http
      .get<Envelope<ApplicantDetail>>(`${this.baseUrl}/${applicationId}`)
      .pipe(map((r) => r.data));
  }

  /**
   * The URL of the SNAPSHOT resume.
   *
   * 🔴 Gated on RESUME.DOWNLOAD on top of APPLICANT.VIEW. A school Viewer can
   * see that a resume exists and cannot open a document carrying a teacher's
   * phone number and home address — the resume IS a contact detail (2.56).
   *
   * ⚠️ Not a static file path. Resumes live under App_Data and are never served
   * statically; this route re-checks the scope and the permission on every hit.
   */
  resumeUrl(applicationId: number): string {
    return `${this.baseUrl}/${applicationId}/resume`;
  }

  /**
   * Fetch the snapshot resume as an object URL the browser can open.
   *
   * ⚠️ NOT `window.open` on the route. That request would arrive without the
   * bearer token and be refused — and the school would see a login page where
   * they expected a CV, with nothing to explain it. The file is fetched as a
   * blob on the authenticated client and handed to the browser afterwards.
   *
   * ⚠️ The caller must revoke the URL it is given, or the blob is held for the
   * life of the tab.
   */
  openResume(applicationId: number): Observable<string> {
    return this.http
      .get(this.resumeUrl(applicationId), {
        responseType: 'blob',
        context: new HttpContext().set(SKIP_LOADER, true),
      })
      .pipe(map((blob) => URL.createObjectURL(blob)));
  }

  /**
   * Move an application along.
   *
   * 🔴 The legal moves come from the server on {@link ApplicantDetail}. This
   * method sends whatever it is given and the server decides — a refusal comes
   * back as INVALID_TRANSITION whether or not a button was drawn for it.
   */
  setStatus(applicationId: number, toStatusId: number, remarks?: string | null): Observable<void> {
    return this.http
      .post<Envelope<unknown>>(`${this.baseUrl}/${applicationId}/status`, { toStatusId, remarks })
      .pipe(map(() => undefined));
  }

  /**
   * The dashboard's counts.
   *
   * 🔴 No parameters, and that IS the security property — the same one
   * `GET /api/jobs/stats` has. There is nothing to forge: a query string
   * appended by hand is ignored and the caller's own counts come back.
   */
  stats(): Observable<SchoolApplicantStats> {
    return this.http
      .get<Envelope<SchoolApplicantStats>>(`${this.baseUrl}/stats`)
      .pipe(map((r) => r.data));
  }
}

/**
 * The refusal codes this feature can produce, as sentences somebody can act on.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ NOTHING HERE IS AN ENTITLEMENT CODE, AND NONE MAY EVER BE ADDED
 * ----------------------------------------------------------------------------
 * Processing applicants is free. The consuming action is the job PUBLISH
 * (2.64) — a QUOTA_EXHAUSTED reaching this screen would mean a school had been
 * charged for reading its own post box.
 */
export function applicantRefusalMessage(code: string | null | undefined, fallback: string): string {
  switch (code) {
    case 'INVALID_TRANSITION':
      /*
        Only reachable by forcing a request, or by acting on a screen somebody
        left open while a colleague moved the same application. So the message
        says the second thing, which is the one that actually happens.
      */
      return 'That change is no longer possible for this application. '
        + 'Someone may have moved it already — reopen it to see where it is now.';

    case 'OFFER_STAGE_UNAVAILABLE':
      return 'Offers are not part of the product yet. This application can be '
        + 'shortlisted, moved to interview, selected or rejected.';

    case 'NO_CHANGE':
      return 'This application is already at that stage.';

    default:
      return fallback;
  }
}
