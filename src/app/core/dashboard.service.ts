import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG } from 'jp-shared/core';
import { ApiResponse } from 'jp-shared/models';
import { Observable, map } from 'rxjs';

/**
 * The plan an account is on.
 *
 * ⚠️ `hasSubscription: false` is a real state, not an error — provisioning is
 * supposed to give every account a plan, and 3B's repair left the possibility
 * of one without. The screen says so rather than showing a blank.
 */
export interface PlanSummary {
  hasSubscription: boolean;
  planName: string | null;
  planCode: string | null;
  price: number | null;
  endsOnUtc: string | null;
  startsOnUtc: string | null;

  /**
   * 🔴 Only correct because the procedure aliases `Is_Active AS IsActive`
   * (2.61). Without the alias it arrives false with nothing failing, and the
   * screen calls a live plan lapsed.
   */
  isActive: boolean;
}

export interface DashboardCampus {
  branchId: number;
  branchName: string;

  /** State and PIN — the city dataset has not been imported (2.47). */
  location: string | null;
}

export interface DashboardTeamMember {
  userUid: string;
  fullName: string | null;
  email: string;
  roleName: string;
  isOwner: boolean;

  /** False until they have signed in — the "Invited" state (2.58). */
  hasArrived: boolean;
}

/**
 * 🔴 THERE IS NO JOB COUNT AND NO APPLICATION COUNT HERE.
 *
 * Jobs are Phase 4 and applications are Phase 5; neither table exists. This
 * screen used to compute both from a fixture file with no HTTP call at all
 * (G6), which is exactly what 3I removed. The areas render as empty states
 * describing what they will be.
 */
export interface SchoolDashboard {
  schoolName: string;
  isVerified: boolean;
  isSuspended: boolean;
  groupType: number | null;
  branchCount: number;
  headOffice: DashboardCampus | null;
  plan: PlanSummary;
  teamMemberCount: number;
  team: DashboardTeamMember[];
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  /**
   * One call, composed server-side.
   *
   * ⚠️ The alternative was three from the browser — profile, team and plan —
   * and the plan alone needs both databases, which no client can join. The
   * server already has to know that a school's subscription is owned by its
   * organisation and a teacher's by the user; that belongs in one place.
   */
  getSchool(): Observable<SchoolDashboard> {
    return this.http
      .get<ApiResponse<SchoolDashboard>>(`${this.api.appApiUrl}/dashboard/school`)
      .pipe(map((response) => response.data as SchoolDashboard));
  }
}
