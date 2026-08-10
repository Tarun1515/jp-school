import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { UiAuthShellComponent, UiAuthShellTone } from 'jp-shared/ui';
import { AuthService } from 'jp-shared/core';
import {
  APPROVAL_STATUS,
  ApprovalDetail,
  ERROR_CODES,
  REQUEST_TYPE,
  RequestDocument,
} from 'jp-shared/models';
import { UiRollComponent, VERIFICATION_STAGES } from 'jp-shared/ui';

import { RegistrationService } from '../../../core/registration.service';

/** One step in the "what happens next" list. */
interface NextStep {
  title: string;
  detail: string;
  /** 'done' | 'now' | 'todo' — drives the margin rule beside the step. */
  state: 'done' | 'now' | 'todo';
}

/** What this screen renders for a given ACCOUNT_* code. */
interface AccountStatusContent {
  /** The state, in the words the user would use. */
  label: string;
  title: string;
  body: string;
  tone: UiAuthShellTone;
  badgeTone: 'warning' | 'danger' | 'neutral';
  /** How far along verification is, 0–3. */
  stage: number;
  rollTone: 'default' | 'waiting' | 'done' | 'struck';
  steps: NextStep[];
  primaryAction: { label: string; route: string } | null;
  /** Shown under the actions when there is something specific to do. */
  aside: string | null;
}

/**
 * Where a signed-in but not-yet-usable account lands.
 *
 * ----------------------------------------------------------------------------
 * THIS IS THE SCREEN WHERE THE WORDS MATTER MOST
 * ----------------------------------------------------------------------------
 * The person reading it has just handed over their school's documents and is
 * waiting on a stranger to approve them. They are anxious, and the thing that
 * makes waiting bearable is knowing exactly where they stand and what happens
 * next. So this page says:
 *
 *   where they are    the roll, marked to the current stage
 *   why it exists     one sentence on why schools are checked at all
 *   what happens next three steps with real timings, not "we'll be in touch"
 *   what they can do  something concrete, so waiting is not the only option
 *
 * "Your account is awaiting verification" with a Sign out button is what this
 * screen used to say. That is accurate and useless.
 *
 * Reachable while pending on purpose — a pending school still has to see where
 * it stands and re-upload documents, which is exactly why login is not blocked
 * for pending accounts (2.9).
 */
@Component({
  selector: 'app-account-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiAuthShellComponent, UiRollComponent, DatePipe],
  templateUrl: './account-status.component.html',
  styleUrl: './account-status.component.scss',
})
export class AccountStatusComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly registration = inject(RegistrationService);

  protected readonly stages = VERIFICATION_STAGES;

  /*----------------------------------------------------------------------------
    🔴 THE REAL REQUEST, NOT A QUERY PARAMETER.

    This screen used to render entirely from ?code=ACCOUNT_PENDING — accurate
    about the account's state and silent about the registration behind it. The
    Phase 1D copy promises "if we do, this page will name exactly which one and
    why", and a promise a screen cannot keep is worse than one it never made.

    So the school's own request is loaded and, when there is one, it decides
    what this page says. The code is the fallback for the states that have no
    request at all — suspended, locked.
  ----------------------------------------------------------------------------*/
  protected readonly request = signal<ApprovalDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly resubmitting = signal(false);

  /** The request number, when they have just sent it. Shown once, at the top. */
  protected readonly justSubmitted = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('submitted'))),
    { initialValue: null },
  );

  /**
   * Documents the admin sent back, with the reason attached.
   *
   * This is what the Phase 1D copy promised and could not deliver: not "a
   * document was rejected" but which one, and in the reviewer's own words.
   */
  protected readonly rejectedDocuments = computed<RequestDocument[]>(() =>
    (this.request()?.documents ?? []).filter((d) => !d.isVerified && d.rejectionReasonId !== null),
  );

  /** The most recent thing an admin did, for the reason on a rejection. */
  protected readonly lastDecision = computed(() => this.request()?.trail?.[0] ?? null);

  protected readonly statusId = computed(() => this.request()?.header.statusId ?? null);

  /** Approved is final and good; rejected is final and not. Neither can be acted on. */
  protected readonly isRejected = computed(() => this.statusId() === APPROVAL_STATUS.rejected);

  protected readonly needsResubmit = computed(
    () => this.statusId() === APPROVAL_STATUS.resubmitRequired,
  );

  protected readonly isDraft = computed(() => this.statusId() === APPROVAL_STATUS.draft);

  /** Nothing started at all — no request, draft or otherwise. */
  protected readonly hasNoRequest = computed(() => !this.loading() && this.request() === null);

  private readonly code = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('code') ?? '')),
    { initialValue: '' },
  );

  constructor() {
    /*
      The newest request wins. A school that was rejected and registered again
      has two, and the one that matters is the one they are waiting on.
    */
    this.registration.myRequests().subscribe({
      next: (rows) => {
        const mine = rows
          .filter((r) => r.requestTypeId === REQUEST_TYPE.schoolRegistration)
          .sort((a, b) => b.requestId - a.requestId)[0];

        if (!mine) {
          this.loading.set(false);
          return;
        }

        this.registration.getById(mine.requestId).subscribe({
          next: (detail) => {
            this.request.set(detail);
            this.loading.set(false);
          },
          error: () => this.loading.set(false),
        });
      },
      error: () => this.loading.set(false),
    });
  }

  /**
   * Asks for another look after replacing a document.
   *
   * ⚠️ Requestor only, and the server enforces it — not "anyone at the school",
   * not an administrator. The button is only rendered for the person who
   * submitted, so the UI does not offer something the API will refuse.
   */
  protected resubmit(): void {
    const request = this.request();

    if (!request || this.resubmitting()) {
      return;
    }

    this.resubmitting.set(true);

    this.registration.resubmit(request.header.requestId, request.header.rowVersion).subscribe({
      next: () => {
        this.resubmitting.set(false);
        // Reload rather than patching the signal: the status, the trail and
        // the row version all moved, and guessing at any of them here is how
        // this screen starts disagreeing with the queue.
        window.location.reload();
      },
      error: () => this.resubmitting.set(false),
    });
  }

  /**
   * Which state this screen should describe.
   *
   * Maps the request's own status onto the same ACCOUNT_* vocabulary the rest
   * of the app already speaks, so there is one switch rather than two that have
   * to stay in step.
   */
  private readonly effectiveCode = computed(() => {
    switch (this.statusId()) {
      case APPROVAL_STATUS.rejected:
        return ERROR_CODES.accountRejected;
      case APPROVAL_STATUS.resubmitRequired:
        return ERROR_CODES.accountResubmitRequired;
      case APPROVAL_STATUS.pending:
        return ERROR_CODES.accountPending;
      default:
        // No request, or one still in draft. Fall back to whatever the API
        // said about the account itself.
        return this.code();
    }
  });

  protected readonly content = computed<AccountStatusContent>(() => {
    /*
      🔴 THE REQUEST DECIDES, NOT THE QUERY STRING.

      A ?code= is what the interceptor put in the URL when the API refused a
      call. It says something true about the ACCOUNT, and nothing about the
      registration — and this screen's whole job is the registration.

      So when the school has a request, its real status wins. The code is the
      fallback for states with no request behind them at all: suspended,
      locked, or an account that never registered.
    */
    switch (this.effectiveCode()) {
      case ERROR_CODES.accountResubmitRequired:
        return {
          label: 'Action needed',
          title: 'We need one document again',
          body:
            'One of the papers you uploaded could not be read clearly enough to verify. ' +
            'Replace it and your school goes straight back into the queue — you do not ' +
            'start again.',
          tone: 'danger',
          badgeTone: 'danger',
          stage: 2,
          rollTone: 'waiting',
          steps: [
            {
              title: 'Upload the replacement',
              detail: 'The documents page lists exactly which one, and why it was returned.',
              state: 'now',
            },
            {
              title: 'We look again',
              detail: 'Usually within one working day, because the rest is already checked.',
              state: 'todo',
            },
            {
              title: 'Your account opens',
              detail: 'Post jobs, search teachers, and invite your team.',
              state: 'todo',
            },
          ],
          primaryAction: { label: 'Upload documents', route: '/account/documents' },
          aside: 'Nothing else you have sent us is affected.',
        };

      case ERROR_CODES.accountRejected:
        return {
          label: 'Not approved',
          title: 'We could not verify this school',
          body:
            'Our team reviewed the registration and was not able to confirm the school. ' +
            'If you think that is wrong — and it sometimes is — write to us and a person ' +
            'will look at it again.',
          tone: 'danger',
          badgeTone: 'danger',
          stage: 2,
          rollTone: 'struck',
          steps: [
            {
              title: 'Write to us',
              detail: 'verify@staffroom.in — tell us your school name and what you sent.',
              state: 'now',
            },
            {
              title: 'A person reviews it',
              detail: 'Not an automated check. Usually within two working days.',
              state: 'todo',
            },
          ],
          primaryAction: null,
          aside: 'Your documents are kept for 30 days in case you appeal.',
        };

      case ERROR_CODES.accountSuspended:
        return {
          label: 'Suspended',
          title: 'This account is suspended',
          body:
            'An administrator has paused access to this account. Your jobs are hidden ' +
            'from teachers while it is suspended, and nothing has been deleted.',
          tone: 'danger',
          badgeTone: 'danger',
          stage: 0,
          rollTone: 'struck',
          steps: [
            {
              title: 'Write to us',
              detail: 'support@staffroom.in — we will tell you what happened and what it takes to lift it.',
              state: 'now',
            },
          ],
          primaryAction: null,
          aside: null,
        };

      case ERROR_CODES.accountLocked:
        return {
          label: 'Locked',
          title: 'This account is locked for a few minutes',
          body:
            'There were several failed sign-in attempts. The lock lifts on its own shortly. ' +
            'If it was not you, change the password once you are back in.',
          tone: 'danger',
          badgeTone: 'danger',
          stage: 0,
          rollTone: 'struck',
          steps: [
            {
              title: 'Wait a few minutes',
              detail: 'Then sign in as usual. Nothing is lost.',
              state: 'now',
            },
            {
              title: 'Or reset your password now',
              detail: 'That clears the lock immediately.',
              state: 'todo',
            },
          ],
          primaryAction: { label: 'Reset password', route: '/auth/forgot-password' },
          aside: null,
        };

      // ACCOUNT_PENDING, and the default, are the same screen: the common case
      // is a school that has just registered.
      default:
        return {
          label: 'In review',
          title: 'Your school is being verified',
          body:
            'We check every school before its jobs go live, so teachers know the listings ' +
            'here are real. Someone on our team is reading your documents now.',
          tone: 'waiting',
          badgeTone: 'warning',
          stage: 2,
          rollTone: 'waiting',
          steps: [
            {
              title: 'We read your documents',
              detail: 'Usually done within two working days. You will get an email either way.',
              state: 'now',
            },
            {
              title: 'We may ask for one more paper',
              detail: 'If we do, this page will name exactly which one and why.',
              state: 'todo',
            },
            {
              title: 'Your account opens',
              detail: 'Post jobs, search teachers, and invite your team.',
              state: 'todo',
            },
          ],
          primaryAction: { label: 'Review your documents', route: '/account/documents' },
          aside: 'You can add or replace documents any time while you wait.',
        };
    }
  });

  protected go(route: string): void {
    void this.router.navigate([route]);
  }

  protected signOut(): void {
    // Local state is already cleared synchronously inside logout(), so the
    // redirect is correct whether or not the server call succeeds.
    this.auth.logout().subscribe({
      next: () => void this.router.navigate(['/auth/login']),
      error: () => void this.router.navigate(['/auth/login']),
    });
  }
}
