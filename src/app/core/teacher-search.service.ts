import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG } from 'jp-shared/core';
import { Observable, map } from 'rxjs';

/**
 * Teacher search and invitations, over HTTP. Phase 6B backend, 6C-2 screens.
 *
 * ----------------------------------------------------------------------------
 * 🔒 THERE IS NO CONTACT FIELD ON ANY SHAPE IN THIS FILE
 * ----------------------------------------------------------------------------
 * Not nulled — ABSENT. A school may search the whole teacher base and read
 * names, subjects, experience and expected salary, and learns nothing about how
 * to reach anybody until that teacher applies to them or accepts an invitation
 * (2.56, LOCKED — exactly two consent paths).
 *
 * The procedure selects no contact column, the DTO is sealed, and
 * ContactLeakGuard reflects over it at startup and refuses to boot the API if
 * one appears. Adding a field here "for convenience" would be caught by three
 * things before a browser ever saw it — which is the point of all three.
 *
 * ⚠️ So the invite flow carries a MESSAGE rather than an email. The school
 * writes something, the platform delivers it, and the teacher decides whether
 * the school gets to contact them. That is the whole product in one exchange.
 */

/** One search result. 🔒 No email, no mobile, no resume — see the header. */
export interface TeacherSearchResult {
  teacherUid: string;
  fullName: string;
  photoPath: string | null;
  genderId: number | null;
  qualificationId: number | null;
  highestQualificationText: string | null;
  designationId: number | null;
  totalExperienceMonths: number | null;
  currentSchool: string | null;
  expectedSalaryMin: number | null;
  expectedSalaryMax: number | null;
  currentCityId: number | null;
  currentStateId: number | null;

  /**
   * The verified badge — a SIGNAL, never a gate (2.9, locked).
   *
   * ⚠️ As of 6C-2-0 this is something a teacher can actually earn: an admin
   * approves their verification request and the badge appears here. Before that
   * every badge in the product was seed data (G37).
   */
  isVerified: boolean;
  profileCompletionPercent: number;

  /**
   * 🔴 FACTS ABOUT THE SCHOOL'S OWN ROWS, not about the teacher.
   *
   * `hasOpenInvite` is "you have already written to this person"; `hasApplied`
   * is "this person already applied to you". Both answer "is there anything to
   * do here", which is what a search result is for — and neither tells the
   * school anything about the teacher's dealings with anybody else.
   */
  hasOpenInvite: boolean;
  hasApplied: boolean;
  isActive: boolean;
}

export interface TeacherSearchFilter {
  subjectId?: number | null;
  designationId?: number | null;
  qualificationId?: number | null;
  classLevelId?: number | null;
  cityId?: number | null;
  stateId?: number | null;
  experienceRangeId?: number | null;
  verifiedOnly?: boolean | null;
  pageNumber?: number;
  pageSize?: number;
}

/** What the school sees of an invitation it sent. 🔒 Still no contact. */
export interface SchoolInvite {
  inviteId: number;
  inviteUid: string;
  teacherUid: string;
  teacherName: string;
  photoPath: string | null;
  isVerified: boolean;
  jobId: number | null;
  jobTitle: string | null;
  branchId: number;
  branchName: string;
  inviteStatusId: number;
  statusName: string;
  message: string | null;
  sentOn: string;
  viewedOn: string | null;
  respondedOn: string | null;

  /** The teacher's own words when they answered, if they wrote any. */
  teacherRemarks: string | null;
}

export interface SendInviteResult {
  /** False with a code when the index refused a duplicate — still a 200. */
  created: boolean;
  code: string | null;
  inviteId: number | null;

  /** Whether the month's quota was charged. FREE mode never charges (2.64). */
  consumed: boolean;
  source: number | null;
}

/** ⚠️ ids come from `m_app_invite_status` (027). */
export const INVITE_STATUS = {
  sent: 1,
  viewed: 2,
  accepted: 3,
  applied: 4,
  ignored: 5,
} as const;

interface Envelope<T> {
  status: number;
  code: string | null;
  message: string;
  data: T;
  totalRecords: number;
}

@Injectable({ providedIn: 'root' })
export class TeacherSearchService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly baseUrl = `${this.api.appApiUrl}/teacher-search`;

  /**
   * The search.
   *
   * 🔴 SERVER-SIDE PAGING FROM DAY ONE, which is G29's lesson: the applicant
   * list shipped with client-side paging under a 200-row cap and the cap was
   * the only thing holding it up. This searches the whole teacher base, where
   * the volume is real, so the page and its total both come from the server.
   */
  search(filter: TeacherSearchFilter): Observable<{ rows: TeacherSearchResult[]; total: number }> {
    let params = new HttpParams();

    const put = (key: string, value: number | boolean | null | undefined) => {
      if (value !== null && value !== undefined && value !== '' as unknown) {
        params = params.set(key, String(value));
      }
    };

    put('subjectId', filter.subjectId);
    put('designationId', filter.designationId);
    put('qualificationId', filter.qualificationId);
    put('classLevelId', filter.classLevelId);
    put('cityId', filter.cityId);
    put('stateId', filter.stateId);
    put('experienceRangeId', filter.experienceRangeId);

    /*
      ⚠️ Sent only when TRUE. `verifiedOnly=false` and an absent parameter mean
      the same thing to the procedure, and sending the former on every search
      would make every URL look like a deliberate choice nobody made.
    */
    if (filter.verifiedOnly) params = params.set('verifiedOnly', 'true');

    params = params.set('pageNumber', String(filter.pageNumber ?? 1));
    params = params.set('pageSize', String(filter.pageSize ?? 20));

    return this.http
      .get<Envelope<TeacherSearchResult[]>>(this.baseUrl, { params })
      .pipe(map((r) => ({ rows: r.data ?? [], total: r.totalRecords ?? 0 })));
  }

  /**
   * Invites one teacher.
   *
   * 🔴 THIS COSTS. TEACHER_INVITE is metered, so the result says whether the
   * month's quota was charged — and a refusal arrives as a 400 with
   * `QUOTA_EXHAUSTED`, which the screen must say in words rather than as a
   * failed request.
   *
   * ⚠️ `created: false` with `code: 'ALREADY_INVITED'` is a SUCCESS on a 200:
   * the invitation the school wanted exists, somebody just clicked twice. The
   * filtered index refused the second insert before the meter was reached, so
   * nothing was charged (020).
   */
  invite(body: {
    teacherUid: string;
    branchId: number;
    jobId?: number | null;
    message?: string | null;
  }): Observable<SendInviteResult> {
    return this.http
      .post<Envelope<SendInviteResult>>(`${this.baseUrl}/invites`, body)
      .pipe(map((r) => r.data));
  }

  /**
   * Every invitation this school has sent.
   *
   * ⚠️ Not entitlement-gated, deliberately. A school whose plan changed must
   * still be able to read what it already sent — taking away the history of a
   * conversation is not what a feature flag is for.
   */
  invites(inviteStatusId?: number | null): Observable<SchoolInvite[]> {
    let params = new HttpParams();
    if (inviteStatusId) params = params.set('inviteStatusId', String(inviteStatusId));

    return this.http
      .get<Envelope<SchoolInvite[]>>(`${this.baseUrl}/invites`, { params })
      .pipe(map((r) => r.data ?? []));
  }
}
