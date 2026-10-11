import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiBadgeComponent, UiEmptyStateComponent, UiModalComponent } from 'jp-shared/ui';

import { SchoolService } from '../../../core/school.service';
import {
  TeacherSearchResult,
  TeacherSearchService,
} from '../../../core/teacher-search.service';

/**
 * 🔒 Find teachers — the school's side of consent path 2.
 *
 * ----------------------------------------------------------------------------
 * 🔒 THERE IS NO CONTACT COLUMN ON THIS SCREEN, FOR ANY PLAN OR ROLE
 * ----------------------------------------------------------------------------
 * A school can read a name, a subject, experience, expected salary and a
 * verified badge. It cannot read an email, a mobile or a resume until that
 * teacher applies to it or accepts an invitation (2.56, LOCKED).
 *
 * The service's own header lists the three places that enforce it. Nothing on
 * this screen could show contact even if somebody tried: the payload does not
 * contain it.
 *
 * ----------------------------------------------------------------------------
 * 🔴 2.62 — BOTH CASES LIVE ON THIS ONE SCREEN
 * ----------------------------------------------------------------------------
 * The invite button has to express two different refusals, and conflating them
 * is the mistake 2.62 exists to prevent:
 *
 *   "not yet"      the plan's invitations are spent, or one is already open
 *                  with this teacher. The control stays, DISABLED, and says
 *                  when it will work again.
 *
 *   "not allowed"  this person does not hold TEACHER_SEARCH.INVITE. The
 *                  control is NOT RENDERED, and one line explains who can.
 *
 * ⚠️ A greyed-out button for the second case reads as "try again later", which
 * is false and sends somebody to support. An absent button for the first reads
 * as "this feature does not exist", which is also false.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ PAGING IS THE SERVER'S
 * ----------------------------------------------------------------------------
 * G29: the applicant list shipped with client-side paging under a 200-row cap,
 * and the cap was the only thing holding it up. This searches the whole teacher
 * base. The page and the total both come from the server, and the filters are
 * applied there too.
 */
@Component({
  selector: 'app-teacher-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiBadgeComponent, UiEmptyStateComponent, UiModalComponent],
  templateUrl: './teacher-search.component.html',
  styleUrl: './teacher-search.component.scss',
})
export class TeacherSearchComponent {
  private readonly search = inject(TeacherSearchService);
  private readonly masters = inject(MasterService);
  private readonly schools = inject(SchoolService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly rows = signal<TeacherSearchResult[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly searched = signal(false);

  protected readonly pageNumber = signal(1);
  protected readonly pageSize = 20;

  /* ---- filters, every one of them from a master (2.7) ------------------ */
  protected readonly subjectId = signal<number | null>(null);
  protected readonly designationId = signal<number | null>(null);
  protected readonly qualificationId = signal<number | null>(null);
  protected readonly classLevelId = signal<number | null>(null);
  protected readonly stateId = signal<number | null>(null);
  protected readonly experienceRangeId = signal<number | null>(null);
  protected readonly verifiedOnly = signal(false);

  protected readonly subjects = signal<Lookup[]>([]);
  protected readonly designations = signal<Lookup[]>([]);
  protected readonly qualifications = signal<Lookup[]>([]);
  protected readonly classLevels = signal<Lookup[]>([]);
  protected readonly states = signal<Lookup[]>([]);
  protected readonly experienceRanges = signal<Lookup[]>([]);

  /* ---- the invite modal ------------------------------------------------- */
  protected readonly inviting = signal<TeacherSearchResult | null>(null);
  protected readonly message = signal('');
  protected readonly sending = signal(false);

  /**
   * 🔴 "NOT ALLOWED" — the control is absent, not disabled.
   *
   * TEACHER_SEARCH.INVITE is separate from TEACHER_SEARCH.VIEW because one of
   * them costs: a school can let somebody browse the teacher base without
   * letting them spend the month's invitations.
   */
  protected readonly canInvite = computed(() => this.auth.hasPermission('TEACHER_SEARCH.INVITE'));

  /**
   * 🔴 2.62 AT SCREEN LEVEL, AND FINDING THIS COST A BROWSER.
   *
   * A school VIEWER holds JOB.VIEW, APPLICANT.VIEW and REPORT.VIEW — not
   * TEACHER_SEARCH.VIEW. The seeded menu row is gated, so they are never
   * offered the link; but typing the URL used to render the whole search form,
   * fire a request, take a 403, and print "No teacher matches those filters".
   *
   * That sentence is false in the most expensive way available: it says the
   * teacher base is empty when the truth is that this person may not look at
   * it. A viewer would reasonably conclude the product has no teachers in it.
   *
   * So the whole screen is the "not allowed" case for them — no form, no
   * request, one explanation. 2.62's rule is about controls, and a screen is
   * the biggest control there is.
   */
  protected readonly canSearch = computed(() => this.auth.hasPermission('TEACHER_SEARCH.VIEW'));

  /**
   * "NOT YET" — set from the server's own refusal, never guessed.
   *
   * ⚠️ The screen does NOT read the plan's quota to predict this. Entitlement
   * state is resolved server-side on every consuming call (2.64), and a client
   * that pre-computes it is a client showing a stale answer the moment an admin
   * flips a switch. So the flag is set when a send comes back QUOTA_EXHAUSTED,
   * and it carries the server's own sentence.
   */
  protected readonly quotaSpent = signal(false);
  protected readonly quotaMessage = signal<string | null>(null);

  protected readonly branchId = signal<number | null>(null);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize)));

  /**
   * ⚠️ RETURNS NULL WHEN THERE IS NOTHING TRUE TO SAY.
   *
   * The first version computed this from the total alone, so a FAILED search
   * printed "No teacher matches those filters" beside the error note — two
   * statements about the same request, one of them a lie. A summary that cannot
   * tell "nobody matched" from "we could not ask" has no business existing.
   */
  protected readonly resultSummary = computed(() => {
    if (this.failed() || this.refused()) return null;
    if (!this.searched()) return 'Set a filter and search, or search with none to see everybody.';

    const n = this.total();
    if (n === 0) return 'No teacher matches those filters.';

    return `${n} teacher${n === 1 ? '' : 's'} match`;
  });

  /**
   * The server refused the search itself — a plan that does not include it, or
   * a permission this person does not hold. Separate from `failed` because one
   * is an answer and the other is a breakage.
   */
  protected readonly refused = signal(false);
  protected readonly refusedMessage = signal<string | null>(null);

  constructor() {
    /*
      ⚠️ Nothing is loaded for somebody who may not search. Fetching masters
      and firing a search they will be refused is six requests to draw a screen
      that says "you cannot use this".
    */
    if (!this.canSearch()) {
      return;
    }

    this.masters.get(MASTER_KEYS.subject).subscribe((v) => this.subjects.set(v));
    this.masters.get(MASTER_KEYS.designation).subscribe((v) => this.designations.set(v));
    this.masters.get(MASTER_KEYS.qualification).subscribe((v) => this.qualifications.set(v));
    this.masters.get(MASTER_KEYS.classLevel).subscribe((v) => this.classLevels.set(v));
    this.masters.get(MASTER_KEYS.state).subscribe((v) => this.states.set(v));
    this.masters.get(MASTER_KEYS.experienceRange).subscribe((v) => this.experienceRanges.set(v));

    /*
      ⚠️ The invitation needs a campus, and branchId is an authorization input
      as well as data (2.39) — so it is a real choice, defaulted to the head
      office because that is the answer for the single-campus school that most
      of them are (2.50).
    */
    this.schools.listBranches(false).subscribe((list) => {
      const head = list.find((b) => b.isHeadOffice) ?? list[0];
      if (head) this.branchId.set(head.branchId);
    });

    this.run();
  }

  protected run(): void {
    if (!this.canSearch()) return;

    this.loading.set(true);
    this.failed.set(false);
    this.refused.set(false);

    this.search
      .search({
        subjectId: this.subjectId(),
        designationId: this.designationId(),
        qualificationId: this.qualificationId(),
        classLevelId: this.classLevelId(),
        stateId: this.stateId(),
        experienceRangeId: this.experienceRangeId(),
        verifiedOnly: this.verifiedOnly(),
        pageNumber: this.pageNumber(),
        pageSize: this.pageSize,
      })
      .subscribe({
        next: ({ rows, total }) => {
          this.rows.set(rows);
          this.total.set(total);
          this.loading.set(false);
          this.searched.set(true);
        },
        error: (error: unknown) => {
          /*
            🔴 403 PLAN_LACKS_FEATURE IS NOT A BROKEN SCREEN.

            TEACHER_SEARCH is the entitlement engine's first Boolean consumer:
            a plan that does not include it refuses the search outright. That is
            a sentence to read, not a stack trace — so it is separated from a
            genuine failure.
          */
          const code = (error as { error?: { code?: string } })?.error?.code ?? null;
          const message = (error as { error?: { message?: string } })?.error?.message ?? null;

          this.rows.set([]);
          this.total.set(0);
          this.loading.set(false);
          this.searched.set(true);

          /*
            🔴 THREE OUTCOMES, AND THEY ARE NOT THE SAME SENTENCE.

              PLAN_LACKS_FEATURE  the plan does not include search. An answer.
              403 anything else   the caller may not search. Also an answer.
              everything else     something broke. Not an answer.

            The first version collapsed the middle one into "broken", and the
            summary line then said "no teacher matches" over the top of it.
          */
          if (code === 'PLAN_LACKS_FEATURE') {
            this.refused.set(true);
            this.refusedMessage.set(message ?? 'Your plan does not include teacher search.');
            this.quotaSpent.set(true);
            this.quotaMessage.set(message ?? 'Your plan does not include teacher search.');

            return;
          }

          const status = (error as { status?: number })?.status ?? 0;

          if (status === 403) {
            this.refused.set(true);
            this.refusedMessage.set(message
              ?? 'You do not have permission to search the teacher base.');

            return;
          }

          this.failed.set(true);
        },
      });
  }

  protected applyFilters(): void {
    this.pageNumber.set(1);
    this.run();
  }

  protected clearFilters(): void {
    this.subjectId.set(null);
    this.designationId.set(null);
    this.qualificationId.set(null);
    this.classLevelId.set(null);
    this.stateId.set(null);
    this.experienceRangeId.set(null);
    this.verifiedOnly.set(false);
    this.applyFilters();
  }

  protected page(delta: number): void {
    const next = this.pageNumber() + delta;
    if (next < 1 || next > this.totalPages()) return;

    this.pageNumber.set(next);
    this.run();
  }

  /** Experience in words. Months are the storage unit; nobody reads months. */
  protected experience(months: number | null): string {
    if (months === null || months <= 0) return 'No experience recorded';

    const years = Math.floor(months / 12);
    const rest = months % 12;

    if (years === 0) return `${rest} month${rest === 1 ? '' : 's'}`;
    if (rest === 0) return `${years} year${years === 1 ? '' : 's'}`;

    return `${years} yr ${rest} mo`;
  }

  protected lookupName(list: Lookup[], id: number | null): string | null {
    if (id === null) return null;

    return list.find((l) => l.id === id)?.name ?? null;
  }

  /**
   * Why this teacher cannot be invited right now, or null when they can.
   *
   * 🔴 BOTH "NOT YET" REASONS, IN WORDS. An open invitation and a spent quota
   * are different facts and a school needs to know which — "Invited" means wait
   * for them, "no invitations left" means wait for the month or change plan.
   */
  protected inviteBlockedBecause(row: TeacherSearchResult): string | null {
    if (row.hasApplied) return 'They have already applied to you — open their application instead.';
    if (row.hasOpenInvite) return 'You have an invitation waiting with this teacher.';
    if (this.quotaSpent()) return this.quotaMessage();

    return null;
  }

  protected openInvite(row: TeacherSearchResult): void {
    this.message.set('');
    this.inviting.set(row);
  }

  protected closeInvite(): void {
    this.inviting.set(null);
  }

  protected send(): void {
    const row = this.inviting();
    const branchId = this.branchId();

    if (!row || branchId === null || this.sending()) return;

    this.sending.set(true);

    this.search
      .invite({ teacherUid: row.teacherUid, branchId, message: this.message().trim() || null })
      .subscribe({
        next: (result) => {
          this.sending.set(false);
          this.closeInvite();

          /*
            ⚠️ ALREADY_INVITED arrives on a 200 with created: false, and it is a
            success — the invitation the school wanted exists, somebody clicked
            twice, and nothing was charged. Saying "sent" would be a small lie;
            saying "failed" would be a bigger one.
          */
          if (result.code === 'ALREADY_INVITED') {
            this.toast.info('You already have an invitation waiting with this teacher.');
          } else {
            this.toast.success('Invitation sent.');
          }

          /*
            🔴 RE-READ, do not patch the row. hasOpenInvite is the server's fact
            about its own rows, and 5B's lesson was a response that reported
            four fields stale because the client patched one of them.
          */
          this.run();
        },
        error: (error: unknown) => {
          this.sending.set(false);

          const code = (error as { error?: { code?: string } })?.error?.code ?? null;
          const message = (error as { error?: { message?: string } })?.error?.message
            ?? 'The invitation could not be sent.';

          /*
            🔴 QUOTA_EXHAUSTED turns the buttons into "not yet" for the rest of
            the session, carrying the SERVER's sentence — which names the period
            and what resets it. Writing our own would mean two places to keep in
            step with a plan's wording.
          */
          if (code === 'QUOTA_EXHAUSTED') {
            this.quotaSpent.set(true);
            this.quotaMessage.set(message);
            this.closeInvite();
          }

          this.toast.error(message);
        },
      });
  }
}
