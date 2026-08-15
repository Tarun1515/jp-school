import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG, SKIP_LOADER } from 'jp-shared/core';
import { ApiResponse } from 'jp-shared/models';
import { Observable, map } from 'rxjs';

/*==============================================================================
  THE SCHOOL'S OWN VIEW OF ITSELF

  ⚠️ Nothing here sends a school id or an organisation id. The server resolves
  the school from the caller's membership (2.39, 2.57), so there is no parameter
  a client could point at somebody else's school.
==============================================================================*/

export interface SchoolBranch {
  branchId: number;
  branchUid: string;
  schoolId: number;
  branchName: string;
  branchCode: string | null;
  isHeadOffice: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  cityId: number | null;
  districtId: number | null;
  stateId: number | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactMobile: string | null;
  isActive: boolean;
  rowVersion: number;
}

export interface SchoolPhoto {
  photoId: number;
  branchId: number | null;
  filePath: string;
  caption: string | null;
  displayOrder: number;
}

export interface SchoolProfile {
  schoolId: number;
  schoolUid: string;
  organizationUid: string;

  schoolName: string;
  schoolTypeId: number | null;
  boardId: number | null;
  affiliationNumber: string | null;
  registrationNo: string | null;
  panNumber: string | null;
  logoPath: string | null;

  /** 1 = single campus, 2 = a group. ⚠️ Null means neither has been declared. */
  groupType: number | null;

  establishedYear: number | null;
  aboutSchool: string | null;
  website: string | null;
  contactEmail: string | null;
  contactMobile: string | null;
  principalName: string | null;
  hrContactName: string | null;
  hrContactMobile: string | null;

  addressLine1: string | null;
  addressLine2: string | null;
  cityId: number | null;
  districtId: number | null;
  stateId: number | null;
  pincode: string | null;

  isVerified: boolean;
  verifiedOn: string | null;
  isSuspended: boolean;
  suspendedOn: string | null;
  suspensionReason: string | null;

  rowVersion: number;
  branchCount: number;

  branches: SchoolBranch[];
  photos: SchoolPhoto[];
  facilityIds: number[];
}

/**
 * The editable half of the profile.
 *
 * 🔴 RowVersion is mandatory and comes from the last read. The server compares
 * it and refuses with CONCURRENCY_CONFLICT rather than overwriting somebody
 * else's edit — the same rule the admin queue has had since 2E.
 *
 * ⚠️ SchoolName is absent because the server will not accept it: a rename
 * changes what was verified. Same for the verification and suspension flags.
 */
export interface UpdateSchoolProfileBody {
  rowVersion: number;

  schoolTypeId: number | null;
  boardId: number | null;
  affiliationNumber: string | null;
  registrationNo: string | null;
  panNumber: string | null;
  groupType: number | null;
  establishedYear: number | null;
  aboutSchool: string | null;
  website: string | null;
  contactEmail: string | null;
  contactMobile: string | null;
  principalName: string | null;
  hrContactName: string | null;
  hrContactMobile: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  cityId: number | null;
  districtId: number | null;
  stateId: number | null;
  pincode: string | null;
}

export interface SaveBranchBody {
  /** Required on update, ignored on insert. */
  rowVersion?: number | null;

  branchName: string;
  branchCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  cityId: number | null;
  districtId: number | null;
  stateId: number | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactMobile: string | null;
  isActive: boolean;
}

export interface SaveBranchResult {
  branchId: number;
  branchUid: string;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class SchoolService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly schoolUrl = `${this.api.appApiUrl}/school`;
  private readonly branchUrl = `${this.api.appApiUrl}/branches`;

  // ---- profile ------------------------------------------------------------

  getProfile(): Observable<SchoolProfile> {
    return this.http
      .get<ApiResponse<SchoolProfile>>(`${this.schoolUrl}/profile`)
      .pipe(map((response) => response.data as SchoolProfile));
  }

  updateProfile(body: UpdateSchoolProfileBody): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.schoolUrl}/profile`, body)
      .pipe(map(() => undefined));
  }

  // ---- logo and photos ----------------------------------------------------

  /**
   * Where the browser fetches an image from.
   *
   * 🔴 A URL built from an ID, never from the stored path. Uploads live under
   * App_Data, which is not served statically and must never be — the same root
   * holds teacher resumes. The API streams the bytes after checking that the
   * caller belongs to the school that owns the photo.
   *
   * ⚠️ These URLs need the Authorization header, so they cannot go straight
   * into an `<img src>`. The gallery fetches them as blobs; see
   * SchoolService.loadImage.
   */
  photoUrl(photoId: number): string {
    return `${this.schoolUrl}/photos/${photoId}/file`;
  }

  logoUrl(): string {
    return `${this.schoolUrl}/logo/file`;
  }

  /**
   * Fetches an image as an object URL the browser can render.
   *
   * The auth interceptor adds the bearer token to this request, which an
   * `<img>` tag could never do on its own.
   *
   * ⚠️ The caller must revoke the object URL when the component goes away, or
   * the blob stays in memory for the life of the tab.
   */
  loadImage(url: string): Observable<string> {
    return this.http
      .get(url, { responseType: 'blob', context: new HttpContext().set(SKIP_LOADER, true) })
      .pipe(map((blob) => URL.createObjectURL(blob)));
  }

  uploadLogo(file: File): Observable<void> {
    const form = new FormData();
    form.append('file', file);

    return this.http
      .post<ApiResponse<unknown>>(`${this.schoolUrl}/logo`, form)
      .pipe(map(() => undefined));
  }

  addPhoto(file: File, caption: string | null, branchId: number | null): Observable<number> {
    const form = new FormData();
    form.append('file', file);
    if (caption) form.append('caption', caption);
    if (branchId !== null) form.append('branchId', String(branchId));

    return this.http
      .post<ApiResponse<{ photoId: number }>>(`${this.schoolUrl}/photos`, form)
      .pipe(map((response) => response.data?.photoId ?? 0));
  }

  /**
   * 🔴 THE ORDER OF THIS ARRAY IS THE DATA — position 1 first.
   *
   * Until 3F the server sorted the ids it was given and wrote insertion order,
   * so every reorder reported success and changed nothing. The positions are
   * explicit all the way down now.
   */
  reorderPhotos(photoIds: number[]): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.schoolUrl}/photos/order`, { photoIds })
      .pipe(map(() => undefined));
  }

  savePhotoCaption(photoId: number, caption: string | null): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.schoolUrl}/photos/${photoId}/caption`, { caption })
      .pipe(map(() => undefined));
  }

  deletePhoto(photoId: number): Observable<void> {
    return this.http
      .delete<ApiResponse<unknown>>(`${this.schoolUrl}/photos/${photoId}`)
      .pipe(map(() => undefined));
  }

  // ---- facilities ---------------------------------------------------------

  /**
   * 🔴 SEND THE COMPLETE SET, NOT THE ONE THAT CHANGED.
   *
   * A full-set sync (2.53): anything absent from this list is removed. That is
   * safe here in a way it was NOT for campus scope — a school owner sees every
   * facility, so what is on screen genuinely is the whole set. 3G found the
   * opposite case, where a partial view plus full-set semantics silently
   * revoked what the caller could not see.
   */
  saveFacilities(facilityIds: number[], branchId: number | null = null): Observable<void> {
    return this.http
      .put<ApiResponse<unknown>>(`${this.schoolUrl}/facilities`, { branchId, facilityIds })
      .pipe(map(() => undefined));
  }

  // ---- branches -----------------------------------------------------------

  listBranches(includeInactive = true): Observable<SchoolBranch[]> {
    return this.http
      .get<ApiResponse<SchoolBranch[]>>(`${this.branchUrl}?includeInactive=${includeInactive}`)
      .pipe(map((response) => response.data ?? []));
  }

  createBranch(body: SaveBranchBody): Observable<SaveBranchResult> {
    return this.http
      .post<ApiResponse<SaveBranchResult>>(this.branchUrl, body)
      .pipe(map((response) => response.data as SaveBranchResult));
  }

  updateBranch(branchId: number, body: SaveBranchBody): Observable<SaveBranchResult> {
    return this.http
      .put<ApiResponse<SaveBranchResult>>(`${this.branchUrl}/${branchId}`, body)
      .pipe(map((response) => response.data as SaveBranchResult));
  }

  /**
   * Removes a campus.
   *
   * ⚠️ The server refuses for reasons the UI must be able to show properly:
   * the head office cannot be removed, and from Phase 4/5 a campus with jobs or
   * applications against it cannot either. Each refusal carries its own code and
   * its own message — display the message, do not invent one.
   */
  deleteBranch(branchId: number, rowVersion: number): Observable<void> {
    return this.http
      .delete<ApiResponse<unknown>>(`${this.branchUrl}/${branchId}`, { body: { rowVersion } })
      .pipe(map(() => undefined));
  }
}
