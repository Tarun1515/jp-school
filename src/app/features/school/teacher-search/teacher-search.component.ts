import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, MasterService, ToastService, UpgradeService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import {
  UiBadgeComponent,
  UiComboboxComponent,
  UiEmptyStateComponent,
  UiModalComponent,
  lookupsToOptions,
} from 'jp-shared/ui';

import { SchoolBranch, SchoolService } from '../../../core/school.service';
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
 *
 * ----------------------------------------------------------------------------
 * 🔴 P2 — THE SCREEN OPENS POINTED AT THE TEACHERS NEAREST THE SCHOOL
 * ----------------------------------------------------------------------------
 * The teacher's job browse has done this since SR-3: it opens already filtered
 * to the work that teacher does, and says so in one line with one click out.
 * This is the same idea from the other side — a school lands on the teachers in
 * its own state rather than on every teacher in India.
 *
 * ⚠️ PRE-FILLED, NEVER HARD-FILTERED, and the difference is the whole design.
 * The state control is an ordinary filter holding an ordinary value: one click
 * on the combobox's × shows everybody. What makes the default honest is that
 * the screen SAYS it applied one — a short list nobody asked for reads as "the
 * teacher base is nearly empty", and nothing on the screen would contradict it.
 * `nearMe` exists to carry that sentence, which is why it is a signal rather
 * than a private boolean.
 *
 * ⚠️ AN UNKNOWN LOCATION IS NOT AN ERROR. No head office, no state recorded on
 * it, or a failed branch read all mean the same thing here: no default, no
 * notice, the plain unfiltered screen. A school that has not finished its
 * profile must still be able to search.
 */
@Component({
  selector: 'app-teacher-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    UiBadgeComponent,
    UiComboboxComponent,
    UiEmptyStateComponent,
    UiModalComponent,
  ],
  templateUrl: './teacher-search.component.html',
  styleUrl: './teacher-search.component.scss',
})
export class TeacherSearchComponent {
  private readonly search = inject(TeacherSearchService);
  private readonly masters = inject(MasterService);
  private readonly schools = inject(SchoolService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  /**
   * 🔴 THE ROAD OUT OF A PLAN REFUSAL, and it goes through UpgradeService
   * rather than a routerLink, exactly as the job list's quota wall does.
   *
   * The service captures the current URL before navigating, so /billing can
   * offer "back to what you were doing" — a plain link to /billing loses that
   * and leaves somebody who upgrades on the pricing page with no way back to
   * the search they were refused.
   */
  private readonly upgrade = inject(UpgradeService);

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

  /*
    G27: THE SAME <ui-combobox> EVERY OTHER MASTER DROPDOWN USES.

    34 subjects, 16 qualifications, 36 states — a native <select> over those is
    a list you can only use if you already know where the name falls
    alphabetically, which is the problem SR-3 added the component for. There is
    ONE such control in jp-shared and this screen uses it; a second
    implementation here is exactly the drift G27 records.

    ⚠️ EXPERIENCE RANGE IS DELIBERATELY STILL A PLAIN <select> — five contiguous
    bands, and a search box over five options is a worse control than the five
    options. That threshold is what the component's own `searchFrom` encodes.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE. `lookupsToOptions(subjects())`
    written in the binding rebuilds the array on every change-detection pass and
    hands <ui-combobox> a fresh `options` identity each time, which defeats the
    OnPush it was given. A computed changes identity only when the master behind
    it actually changes — here, once, when the master arrives.
  */
  protected readonly subjectOptions = computed(() => lookupsToOptions(this.subjects()));
  protected readonly designationOptions = computed(() => lookupsToOptions(this.designations()));
  protected readonly qualificationOptions = computed(() => lookupsToOptions(this.qualifications()));
  protected readonly classLevelOptions = computed(() => lookupsToOptions(this.classLevels()));
  protected readonly stateOptions = computed(() => lookupsToOptions(this.states()));

  /* ---- P2: the school's own location, as a default -------------------- */

  /**
   * Whether the state showing in the filter was OURS to set, not the user's.
   *
   * 🔴 IT MUST BE SAID ON SCREEN, which is the only reason this is a signal.
   * A list narrowed by a filter the school never chose is indistinguishable
   * from a product with hardly any teachers in it, and they would act on that
   * — so the notice and the one-click way out are not decoration, they are
   * what makes a helpful default something other than a trap.
   *
   * Cleared the moment the school touches the state control, clears the
   * filters, or widens: from then on the list is theirs, and taking credit for
   * their choice would be its own small lie.
   */
  protected readonly nearMe = signal(false);

  /**
   * ⚠️ NOT SHOWN OVER A REFUSAL OR A BREAKAGE. "Showing teachers near you" is
   * a claim about a list, and when the plan refused the search or the request
   * fell over there is no list — the same rule `resultSummary` follows.
   */
  protected readonly showNearMeNote = computed(() =>
    this.nearMe() && !this.refused() && !this.failed());

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

  /**
   * 🔴 THE REFUSAL THAT HAS A ROAD OUT, AND IT IS SAID ONCE.
   *
   * PLAN_LACKS_FEATURE used to set `refused` AND `quotaSpent` from the same
   * sentence, so the screen printed the server's words twice: a banner above
   * the filters and a second box below them. Two copies of one fact read as
   * two problems, and the school counted them.
   *
   * So the sentence belongs to `refused` and there is exactly one banner for
   * it. This flag carries only what the other refusals do not have — somewhere
   * to go — and decides whether that one banner also offers the plans. A
   * missing PERMISSION is not fixed by paying: offering an upgrade for it would
   * be selling somebody something that does not solve their problem.
   *
   * ⚠️ The filters stay on screen either way. Saying why something is
   * unavailable and showing the road to it is the standing decision; hiding
   * the feature would make it look like it does not exist.
   */
  protected readonly planGated = signal(false);

  /**
   * Why Search is disabled, or null while it works.
   *
   * 🔴 2.62 AGAIN, ON THE SEARCH BUTTON. The control stays and carries its own
   * reason (`title` + `aria-describedby` on to the banner), so somebody who
   * reaches for it learns why from the thing they pressed rather than from a
   * request that comes back refused a second time.
   */
  protected readonly searchBlockedBecause = computed(() =>
    (this.refused() ? this.refusedMessage() : null));

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

      🔴 P2: THE SAME ONE REQUEST ALSO ANSWERS "WHERE IS THIS SCHOOL". The head
      office branch carries the address provisioning copied from the
      registration (001_provisioning), so the state the school typed when it
      signed up is already on its way here for the invite's campus. Asking
      /school/profile for it as well would be a second request for a fact this
      one already contains.

      🔴 AND THE FIRST SEARCH WAITS FOR IT. Firing the search in parallel would
      mean an unfiltered result set landing first and the near-you one replacing
      it a moment later — a list that moves under the reader, and two requests
      where one does. So `run()` is called from BOTH arms: a branch read that
      fails is not an error on this screen, it just means no default.
    */
    this.schools.listBranches(false).subscribe({
      next: (list) => {
        const head = list.find((b) => b.isHeadOffice) ?? list[0];
        if (head) this.branchId.set(head.branchId);

        this.startNearSchool(head ?? null);
        this.run();
      },
      error: () => this.run(),
    });
  }

  /**
   * P2. Open the screen on the teachers nearest this school.
   *
   * ----------------------------------------------------------------------------
   * 🔴 WHY THE DEFAULT IS A STATE AND NOT THE HEAD OFFICE'S TOWN
   * ----------------------------------------------------------------------------
   * The head office knows its district and its town as well as its state, and
   * neither is used. The district CANNOT be: there is no district anywhere in
   * the search chain — `t_app_teachers` stores CurrentCityId and CurrentStateId
   * only, `USP_SearchTeachers` takes @CityId and @StateId, and TeacherSearchQuery
   * carries the same two. A district default would be a backend change first and
   * a screen change second; sending one from here would filter nothing.
   *
   * The town is available and is still not used, because a default must be
   * wide enough to be worth opening. Narrowing a school in Hisar to teachers
   * who recorded Hisar as their own town hides every teacher one town over who
   * would happily take the job — which is the pre-filter failure this whole
   * design is built to avoid, just at a smaller radius. The state is the unit
   * the teacher side pre-fills on too (SR-3), and the two screens agreeing on
   * what "near" means is worth more than a tighter radius on one of them.
   *
   * ⚠️ NO STATE ON THE BRANCH MEANS NO DEFAULT AND NO NOTICE. Not an empty
   * filter that looks set, not a toast: the ordinary screen, showing everybody.
   */
  private startNearSchool(head: SchoolBranch | null): void {
    const stateId = head?.stateId ?? null;

    if (stateId === null) return;

    this.stateId.set(stateId);
    this.nearMe.set(true);
  }

  protected run(): void {
    if (!this.canSearch()) return;

    this.loading.set(true);
    this.failed.set(false);
    this.refused.set(false);
    this.planGated.set(false);

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
            /*
              ⚠️ ONE FLAG FOR THE SENTENCE, ONE FOR THE ROAD OUT — and
              deliberately NOT `quotaSpent` as well. Setting both is what
              printed this refusal twice: `quotaSpent` is the invite meter's own
              state, with its own banner, and borrowing it to disable the invite
              buttons meant the same words appeared above the filters and again
              below them. The invite buttons do not need it here anyway — a
              refused search has no rows to invite from — and
              `inviteBlockedBecause` reads `planGated` directly for the case
              where rows are already on screen.
            */
            this.refused.set(true);
            this.refusedMessage.set(message ?? 'Your plan does not include teacher search.');
            this.planGated.set(true);

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

    /*
      ⚠️ The notice goes with the filter it describes. Clearing takes the state
      out, so the list is no longer "near you" and saying it would be false.
    */
    this.nearMe.set(false);
    this.applyFilters();
  }

  /**
   * The state filter changed by hand.
   *
   * ⚠️ NO SEARCH IS FIRED — every filter on this screen is applied by the
   * Search button, and one control that re-queried on change would be a
   * surprise in a toolbar where nothing else does.
   *
   * ⚠️ BUT THE NOTICE GOES IMMEDIATELY. The moment a state is chosen — or the
   * combobox's × empties it — that box holds the school's own answer rather
   * than ours, and a line taking credit for a filter somebody else just set is
   * worse than no line at all.
   */
  protected onStateChange(stateId: number | null): void {
    this.stateId.set(stateId);
    this.nearMe.set(false);
  }

  /**
   * "Show teachers everywhere" — the one click out of the default.
   *
   * 🔴 THIS ONE DOES SEARCH IMMEDIATELY, and that is not inconsistent: it is
   * not a filter control, it is a named action whose label says exactly what
   * will happen. SR-3 learned the same thing on the teacher side — "Clear
   * filters" asks somebody to work out that filters they never set exist,
   * where "Show all jobs" just says what the button does.
   *
   * ⚠️ It drops ONLY the location. The school may well have set a subject
   * meanwhile, and throwing that away would make the way out cost something.
   */
  protected showEverywhere(): void {
    this.stateId.set(null);
    this.nearMe.set(false);
    this.applyFilters();
  }

  /** To the plans, remembering this screen. See `upgrade` above for why. */
  protected seePlans(): void {
    this.upgrade.showPlans();
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

    /*
      ⚠️ The plan refusal reaches the invite buttons through its OWN flag now,
      not by borrowing `quotaSpent` — which is what duplicated the banner. Rows
      and a gated plan rarely coexist (a refused search clears the rows), but
      they can: a search that succeeded before the plan changed leaves rows on
      screen, and an Invite button that looks live there would be a click that
      goes nowhere.
    */
    if (this.planGated()) return this.refusedMessage();

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
