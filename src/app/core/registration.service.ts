import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG, SKIP_LOADER } from 'jp-shared/core';
import {
  ApiResponse,
  ApprovalDetail,
  ApprovalListItem,
  DocumentType,
  SaveDraftBody,
  SaveDraftResult,
  SubmitApprovalResult,
} from 'jp-shared/models';
import { Observable, map } from 'rxjs';

/** What an upload came back with. */
export interface UploadResult {
  documentId: number;
}

/**
 * The slice of /api/masters/bulk this app reads.
 *
 * 🔴 Document types come from HERE and not from /api/masters/document-type.
 *
 * The generic master shape is Id / Code / Name / DisplayOrder / ParentId, and
 * it drops the three fields that make a document type useful: IsMandatory,
 * MaxSizeKb and AllowedExtensions. Reading the generic endpoint gave a form
 * where nothing was ever marked required, so the "you still need this" gate
 * silently passed and the size hint was a guess (2.47 puts those limits in
 * data precisely so nobody guesses).
 */
interface MasterBundle {
  documentTypes: DocumentType[];
}

/**
 * The school's own side of the approval engine.
 *
 * ⚠️ Every call here is scoped to the caller by the server, from the token
 * (decision 2.39). There is no organisation or user id to pass, and adding one
 * would create a parameter somebody could change.
 */
@Injectable({ providedIn: 'root' })
export class RegistrationService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  private readonly baseUrl = `${this.api.appApiUrl}/approvals`;

  /**
   * Saves the form as it currently stands.
   *
   * 🔴 Server-side. A draft in localStorage is one the school loses the moment
   * they switch device — along with the documents already uploaded against it,
   * which is the point at which they stop coming back.
   *
   * Out of the global spinner: this fires on every step change, and blacking
   * out the screen each time would make moving through the form feel like the
   * app is fighting you. The step header shows the save state instead.
   */
  saveDraft(body: SaveDraftBody): Observable<SaveDraftResult> {
    return this.http
      .post<ApiResponse<SaveDraftResult>>(`${this.baseUrl}/draft`, body, {
        context: new HttpContext().set(SKIP_LOADER, true),
      })
      .pipe(map((response) => response.data as SaveDraftResult));
  }

  /**
   * The caller's draft, or null.
   *
   * ⚠️ Null is the normal answer for a school that has not started. It comes
   * back as a 200 with no data rather than a 404, so the first visit does not
   * look like a failure.
   */
  getDraft(): Observable<ApprovalDetail | null> {
    return this.http
      .get<ApiResponse<ApprovalDetail | null>>(`${this.baseUrl}/draft`)
      .pipe(map((response) => response.data ?? null));
  }

  /** Turns the draft into a request the admin queue can see. */
  submitDraft(requestId: number): Observable<SubmitApprovalResult> {
    return this.http
      .post<ApiResponse<SubmitApprovalResult>>(`${this.baseUrl}/draft/${requestId}/submit`, {})
      .pipe(map((response) => response.data as SubmitApprovalResult));
  }

  /**
   * The document types a school registration needs, with their real rules.
   *
   * Cacheable for an hour server-side (2.48), so asking on every visit to the
   * form costs nothing after the first.
   */
  documentTypes(): Observable<DocumentType[]> {
    return this.http
      .get<ApiResponse<MasterBundle>>(`${this.api.appApiUrl}/masters/bulk`)
      .pipe(map((response) => response.data?.documentTypes ?? []));
  }

  /**
   * The school's own requests, newest first.
   *
   * The account-status page reads this. An admin sees every organisation here;
   * a school sees only its own, decided by the server from the token.
   */
  myRequests(): Observable<ApprovalListItem[]> {
    return this.http
      .get<ApiResponse<ApprovalListItem[]>>(this.baseUrl, {
        params: { pageNumber: 1, pageSize: 20 },
      })
      .pipe(map((response) => response.data ?? []));
  }

  getById(requestId: number): Observable<ApprovalDetail> {
    return this.http
      .get<ApiResponse<ApprovalDetail>>(`${this.baseUrl}/${requestId}`)
      .pipe(map((response) => response.data as ApprovalDetail));
  }

  /**
   * Resubmits after a resubmission was requested.
   *
   * ⚠️ Requestor only, enforced on the server — not "anyone in the school", and
   * not an admin. A resubmission is the applicant's answer to a rejection.
   */
  resubmit(requestId: number, rowVersion: number, remarks?: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/${requestId}/resubmit`, { rowVersion, remarks });
  }

  /**
   * Uploads one document against a request.
   *
   * ⚠️ The size and type rules are the SERVER's (2.48), read from the document
   * type row. The form shows them so the school knows before choosing a file,
   * but it never invents its own — two rules that can disagree is one rule too
   * many, and the one that would win is the one nobody sees.
   */
  upload(requestId: number, documentTypeId: number, file: File): Observable<UploadResult> {
    const form = new FormData();
    form.append('requestId', String(requestId));
    form.append('documentTypeId', String(documentTypeId));
    form.append('file', file, file.name);

    return this.http
      .post<ApiResponse<UploadResult>>(`${this.api.appApiUrl}/documents/upload`, form)
      .pipe(map((response) => response.data as UploadResult));
  }
}
