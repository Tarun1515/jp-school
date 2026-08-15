import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG } from 'jp-shared/core';
import { ApiResponse } from 'jp-shared/models';
import { Observable, map } from 'rxjs';

/**
 * What somebody is TO this school.
 *
 * ⚠️ Not what they may DO — that is their jp_sso role and its permissions. The
 * two are kept in step by the API, which is the only place that can see both
 * databases.
 *
 * 🔴 Owner is here because it comes back from the server. It is never SENT:
 * a school has exactly one, it can never be demoted or deactivated, and so
 * granting a second is permanent. The API refuses it as well.
 */
export const SCHOOL_ROLE = {
  owner: 1,
  seniorHr: 2,
  hr: 3,
  viewer: 4,
} as const;

/** The roles an invitation or a role change may use. Owner is deliberately absent. */
export const ASSIGNABLE_ROLES = [
  {
    value: SCHOOL_ROLE.seniorHr,
    label: 'Senior HR',
    help: 'Posts jobs, reviews applicants, shortlists, and makes offers.',
  },
  {
    value: SCHOOL_ROLE.hr,
    label: 'HR',
    help: 'Posts jobs and reviews applicants. Cannot make offers.',
  },
  {
    value: SCHOOL_ROLE.viewer,
    label: 'Viewer',
    help: 'Reads jobs and applicants. Changes nothing.',
  },
] as const;

export interface TeamCampus {
  branchId: number;
  branchName: string;
  isHeadOffice: boolean;
}

export interface TeamMember {
  userUid: string;
  fullName: string | null;
  email: string;
  designationText: string | null;
  roleInSchool: number;
  roleName: string;
  isOwner: boolean;
  isActive: boolean;

  /** jp_sso account status. 2 = Active; anything else means they have not signed in yet. */
  accountStatusId: number;
  accountStatusCode: string;

  /** The campuses they are scoped to, AS THIS CALLER CAN SEE THEM. */
  branchIds: number[];

  /**
   * The TRUE number of campuses they are scoped to.
   *
   * ⚠️ Deliberately allowed to exceed `branchIds.length`. The difference is
   * campuses this caller has no access to, and the screen says so rather than
   * under-reporting a colleague's access.
   */
  branchCount: number;

  lastLoginOnUtc: string | null;
  createdOnUtc: string;
}

export interface SchoolTeam {
  /** 1 = single campus. At 1 the campus-scope control does not exist (2.50). */
  groupType: number | null;
  campuses: TeamCampus[];
  members: TeamMember[];
}

export interface InviteTeamMemberBody {
  email: string;
  fullName?: string | null;
  mobile?: string | null;
  roleInSchool: number;
  designationText?: string | null;
  branchIds: number[];
}

export interface InviteTeamMemberResult {
  userUid: string;
  email: string;
  inviteExpiresOnUtc: string | null;
  alreadyOnTeam: boolean;
  existingAccountAttached: boolean;
}

export interface SaveTeamMemberRoleBody {
  roleInSchool: number;
  fullName?: string | null;
  designationText?: string | null;
}

/**
 * The school's own team.
 *
 * ⚠️ Nothing here passes a school id or an organisation id. The server resolves
 * the school from the caller's membership (2.39, 2.57); the uid in a URL is
 * always the TARGET colleague's, and the server refuses one that is not on this
 * school's team with a 404.
 */
@Injectable({ providedIn: 'root' })
export class TeamService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly baseUrl = `${this.api.appApiUrl}/school/team`;

  get(): Observable<SchoolTeam> {
    return this.http
      .get<ApiResponse<SchoolTeam>>(this.baseUrl)
      .pipe(map((response) => response.data as SchoolTeam));
  }

  invite(body: InviteTeamMemberBody): Observable<InviteTeamMemberResult> {
    return this.http
      .post<ApiResponse<InviteTeamMemberResult>>(`${this.baseUrl}/invite`, body)
      .pipe(map((response) => response.data as InviteTeamMemberResult));
  }

  saveRole(userUid: string, body: SaveTeamMemberRoleBody): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.baseUrl}/${userUid}/role`, body)
      .pipe(map(() => undefined));
  }

  /**
   * 🔴 SEND THE COMPLETE SET OF CAMPUSES, NOT THE ONE THAT CHANGED.
   *
   * A full-set sync, like every other bridge in this API. Sending `[3]` when
   * they already have `[1, 3]` removes campus 1 — so the caller here always
   * sends every ticked box, never the delta.
   */
  saveBranches(userUid: string, branchIds: number[]): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.baseUrl}/${userUid}/branches`, { branchIds })
      .pipe(map(() => undefined));
  }

  /**
   * Removes somebody's access.
   *
   * ⚠️ DELETE is the verb; deletion is not what happens. The membership is
   * marked inactive and their sessions are revoked. Everything they did — every
   * document they verified, every job they posted — stays attributed to them.
   */
  remove(userUid: string): Observable<void> {
    return this.http
      .delete<ApiResponse<unknown>>(`${this.baseUrl}/${userUid}`)
      .pipe(map(() => undefined));
  }
}
