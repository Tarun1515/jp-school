import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { JP_API_CONFIG } from 'jp-shared/core';
import { Observable, map } from 'rxjs';

/**
 * Offers, the school's side. Phase 6A backend, 6C-2 screens.
 *
 * ----------------------------------------------------------------------------
 * 🔴 WHY THESE ARE NOT THE STATUS ENDPOINT, AND WHY THAT MATTERED
 * ----------------------------------------------------------------------------
 * 2.73's transition map permits 5 → 7 (Selected → OfferSent), so a Selected
 * application's `allowedTransitions` legitimately contains OFFER_SENT. But the
 * generic status endpoint REFUSES 7..10 with OFFER_ACTION_REQUIRED, because
 * those stages are only produced by an offer action that writes the offer row
 * in the same transaction — otherwise a school could mark somebody Hired with
 * nobody having accepted anything.
 *
 * ⚠️ So from 6A until 6C-2 the applicant detail drew an "Offer sent" button
 * from that list and clicking it returned a 400. Its own comment said "either
 * alone would draw a button that produces a refusal", and that is precisely
 * what shipped — found by walking an application to Selected and looking at the
 * screen.
 *
 * These methods are the actions that stage actually needs, and the detail
 * screen now filters the offer stages out of the generic list.
 */

/** One offer on an application, as the school reads it. */
export interface SchoolOffer {
  offerId: number;
  offerUid: string;
  applicationId: number;
  branchId: number;
  branchName: string;
  designationId: number;
  offeredSalary: number | null;
  joiningDate: string | null;
  reportingTime: string | null;
  termsAndConditions: string | null;
  offerStatusId: number;
  offerStatusName: string;

  /** The one offer on this application that is still answerable. */
  isLive: boolean;

  sentOn: string;
  sentByUserId: number | null;
  sentByName: string | null;
  respondedOn: string | null;

  /** The teacher's own words when they answered. Shown to the school. */
  teacherRemarks: string | null;

  /** 🔒 The school's own note. Never sent to the teacher (018). */
  withdrawalReason: string | null;

  rowVersion: number;
  isActive: boolean;
}

export interface SendOfferBody {
  designationId: number;
  offeredSalary?: number | null;
  joiningDate?: string | null;
  reportingTime?: string | null;
  termsAndConditions?: string | null;
}

/** ⚠️ ids from `m_app_offer_status` (025). */
export const OFFER_STATUS = {
  sent: 1,
  accepted: 2,
  declined: 3,
  withdrawn: 4,
} as const;

interface Envelope<T> {
  status: number;
  code: string | null;
  message: string;
  data: T;
}

@Injectable({ providedIn: 'root' })
export class OfferService {
  private readonly api = inject(JP_API_CONFIG);
  private readonly http = inject(HttpClient);

  /** Every offer on one application — the negotiation, not just the latest. */
  forApplication(applicationId: number): Observable<SchoolOffer[]> {
    return this.http
      .get<Envelope<SchoolOffer[]>>(`${this.api.appApiUrl}/applicants/${applicationId}/offers`)
      .pipe(map((r) => r.data ?? []));
  }

  /**
   * Sends an offer, moving the application to OfferSent in one transaction.
   *
   * ⚠️ A second live offer on the same application is refused by a filtered
   * unique index (026) with ALREADY_OFFERED — reachable by a double-click, and
   * the screen must say it rather than swallow it.
   */
  send(applicationId: number, body: SendOfferBody): Observable<{ offerId: number }> {
    return this.http
      .post<Envelope<{ offerId: number }>>(`${this.api.appApiUrl}/applicants/${applicationId}/offers`, body)
      .pipe(map((r) => r.data));
  }

  /**
   * Withdraws a live offer and puts the application back to Selected.
   *
   * 🔒 The reason is the school's own note and is NOT sent to the teacher
   * (018) — they are told the offer was withdrawn, and nothing more.
   */
  withdraw(offerId: number, reason?: string | null): Observable<void> {
    return this.http
      .post<Envelope<unknown>>(`${this.api.appApiUrl}/offers/${offerId}/withdraw`, {
        reason: reason?.trim() || null,
      })
      .pipe(map(() => undefined));
  }

  /**
   * Confirms the hire — 2.73's separate second step.
   *
   * 🔴 Gated on OFFER.APPROVE, which is a DIFFERENT permission from
   * OFFER.CREATE: whoever sends an offer is not necessarily whoever confirms
   * somebody has actually started.
   */
  confirmHire(applicationId: number, remarks?: string | null): Observable<void> {
    return this.http
      .post<Envelope<unknown>>(`${this.api.appApiUrl}/applicants/${applicationId}/hire`, {
        remarks: remarks?.trim() || null,
      })
      .pipe(map(() => undefined));
  }
}
