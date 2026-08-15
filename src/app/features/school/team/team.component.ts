import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService, ConfirmDialogService, ToastService } from 'jp-shared/core';
import { UiBadgeComponent, UiButtonComponent, UiInputComponent, UiModalComponent, UiSelectComponent } from 'jp-shared/ui';

import {
  ASSIGNABLE_ROLES,
  SCHOOL_ROLE,
  SchoolTeam,
  TeamMember,
  TeamService,
} from '../../../core/team.service';

/**
 * The team screen — who works here, what they are, and which campuses they see.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE OWNER ROW IS DIFFERENT, NOT DISABLED
 * ----------------------------------------------------------------------------
 * An owner cannot be demoted, cannot be removed, and is never scoped to a
 * campus — they see all of them by definition. The obvious rendering is a row
 * of greyed checkboxes and greyed buttons, and it is the wrong one: a disabled
 * control reads as BROKEN, and the reader's next move is to click it anyway,
 * then reload, then ask somebody.
 *
 * So the owner's row has no controls at all. It carries a marked left rule, a
 * tinted ground and, where the ticks would be, a sentence saying what is true:
 * "Every campus — the owner is never scoped to one." Nothing to click and
 * nothing to wonder about.
 *
 * ----------------------------------------------------------------------------
 * THE MATRIX
 * ----------------------------------------------------------------------------
 * People down, campuses across, a checkbox at each crossing. Ticking one saves
 * immediately and sends the person's COMPLETE set, because the endpoint is a
 * full-set sync (2.53) — sending only the box that changed would remove all the
 * others.
 *
 * ⚠️ At GroupType 1 the campus columns do not exist. A single-campus school
 * asking "which campuses may they see" is asking a question with one answer,
 * and it makes a simple school look like a complicated one (2.50).
 *
 * ⚠️ `branchCount` can exceed the ticks shown. That is not a bug and is not
 * hidden: campuses THIS reader has no access to are still real access for their
 * colleague, so the row says "+2 you cannot see" rather than quietly
 * under-reporting it. Saving does not touch those — the server refuses to
 * remove what the caller could not see.
 */
@Component({
  selector: 'app-team',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    UiBadgeComponent,
    UiButtonComponent,
    UiInputComponent,
    UiModalComponent,
    UiSelectComponent,
  ],
  templateUrl: './team.component.html',
  styleUrl: './team.component.scss',
})
export class TeamComponent {
  private readonly team = inject(TeamService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  protected readonly data = signal<SchoolTeam | null>(null);
  protected readonly loading = signal(true);

  /** Which rows have a save in flight, so only that row shows it. */
  protected readonly savingUids = signal<ReadonlySet<string>>(new Set());

  protected readonly inviteOpen = signal(false);
  protected readonly inviting = signal(false);
  protected readonly editing = signal<TeamMember | null>(null);
  protected readonly savingEdit = signal(false);

  protected readonly roles = ASSIGNABLE_ROLES;

  protected readonly roleOptions = ASSIGNABLE_ROLES.map((role) => ({
    value: role.value,
    label: role.label,
  }));

  /**
   * Whether this reader may change anything.
   *
   * The server enforces it on every write; this only decides whether to render
   * controls that would be refused. A screen full of buttons that all fail is
   * worse than a screen without them.
   */
  protected readonly canManage = computed(() => this.auth.hasPermission('USER.MANAGE'));

  protected readonly campuses = computed(() => this.data()?.campuses ?? []);

  /** ⚠️ A single-campus school has no campus scope at all (2.50). */
  protected readonly showCampusScope = computed(
    () => this.data()?.groupType !== 1 && this.campuses().length > 0,
  );

  protected readonly members = computed(() => this.data()?.members ?? []);

  protected readonly editTitle = computed(() => {
    const member = this.editing();

    return member === null ? 'Edit' : `Edit ${this.displayName(member)}`;
  });

  protected readonly activeCount = computed(() => this.members().filter((m) => m.isActive).length);

  protected readonly invitedCount = computed(
    () => this.members().filter((m) => m.isActive && m.lastLoginOnUtc === null).length,
  );

  protected readonly inviteForm = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.maxLength(150)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(150)]],
    designationText: ['', [Validators.maxLength(150)]],
    roleInSchool: [SCHOOL_ROLE.hr as number, [Validators.required]],
  });

  protected readonly editForm = this.fb.nonNullable.group({
    fullName: ['', [Validators.maxLength(150)]],
    designationText: ['', [Validators.maxLength(150)]],
    roleInSchool: [SCHOOL_ROLE.hr as number, [Validators.required]],
  });

  /** The campuses ticked in the invite dialog. Kept out of the form: it is a set, not a field. */
  protected readonly inviteBranchIds = signal<ReadonlySet<number>>(new Set());

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);

    this.team.get().subscribe({
      next: (team) => {
        this.data.set(team);
        this.loading.set(false);
      },
      error: () => {
        // The interceptor has already said what went wrong. Clearing the rows
        // matters more: a stale team list under a failed refresh is one
        // somebody makes a decision from.
        this.data.set(null);
        this.loading.set(false);
      },
    });
  }

  // ---- reading a row ------------------------------------------------------

  /** The name if the school recorded one, otherwise the address they sign in with. */
  protected displayName(member: TeamMember): string {
    return member.fullName?.trim() || member.email;
  }

  /** Shown under the name, and never repeating it. */
  protected secondLine(member: TeamMember): string {
    const bits: string[] = [];

    if (member.fullName?.trim()) {
      bits.push(member.email);
    }

    if (member.designationText?.trim()) {
      bits.push(member.designationText.trim());
    }

    return bits.join(' · ');
  }

  protected hasCampus(member: TeamMember, branchId: number): boolean {
    return member.branchIds.includes(branchId);
  }

  /** Campuses they hold that this reader has no access to. Never hidden. */
  protected hiddenCampusCount(member: TeamMember): number {
    return Math.max(0, member.branchCount - member.branchIds.length);
  }

  protected isSaving(member: TeamMember): boolean {
    return this.savingUids().has(member.userUid);
  }

  protected rowState(member: TeamMember): string {
    if (member.isOwner) return 'row--owner';
    if (!member.isActive) return 'row--muted';

    return '';
  }

  protected statusTone(member: TeamMember): 'neutral' | 'success' | 'warning' {
    if (!member.isActive) return 'neutral';

    return this.hasArrived(member) ? 'success' : 'warning';
  }

  protected statusLabel(member: TeamMember): string {
    if (!member.isActive) return 'Removed';

    return this.hasArrived(member) ? 'Active' : 'Invited';
  }

  /**
   * Whether they have ever actually got in.
   *
   * ⚠️ NOT the jp_sso account status. USP_InviteSchoolUser creates the account
   * ACTIVE with no credential — the invitee sets their own password by redeeming
   * the token — so status says "Active" from the moment the invitation is sent
   * and cannot tell an arrived colleague from one who never opened the email.
   *
   * A null last-login can. It is the difference between "they have not replied"
   * and "something is wrong with our account", which is the whole reason a
   * school looks at this column.
   */
  private hasArrived(member: TeamMember): boolean {
    return member.lastLoginOnUtc !== null;
  }

  // ---- the matrix ---------------------------------------------------------

  /**
   * Ticks or unticks one campus for one person.
   *
   * 🔴 Sends the COMPLETE set, never the box that changed. The endpoint diffs
   * against what is stored and removes whatever is absent.
   */
  protected toggleCampus(member: TeamMember, branchId: number, checked: boolean): void {
    if (member.isOwner || !this.canManage()) {
      return;
    }

    const next = checked
      ? [...member.branchIds, branchId]
      : member.branchIds.filter((id) => id !== branchId);

    const campusName = this.campuses().find((c) => c.branchId === branchId)?.branchName ?? 'that campus';

    this.setSaving(member.userUid, true);

    this.team.saveBranches(member.userUid, next).subscribe({
      next: () => {
        this.applyBranches(member.userUid, next);
        this.setSaving(member.userUid, false);

        // Named, both ways. "Saved" would not tell somebody who mis-clicked
        // what they had just done.
        this.toast.success(
          checked
            ? `${this.displayName(member)} can now see ${campusName}.`
            : `${this.displayName(member)} can no longer see ${campusName}.`,
        );

        if (!checked && next.length === 0 && this.hiddenCampusCount(member) === 0) {
          this.toast.warning(
            `${this.displayName(member)} is not on any campus now, so they will sign in to an empty school.`,
          );
        }
      },
      error: () => {
        // Reload rather than trusting the local guess: the refusal may have
        // been the owner rule or a campus this reader cannot assign, and the
        // checkbox must end up showing what the server actually holds.
        this.setSaving(member.userUid, false);
        this.load();
      },
    });
  }

  private applyBranches(userUid: string, branchIds: number[]): void {
    this.data.update((team) =>
      team === null
        ? team
        : {
            ...team,
            members: team.members.map((m) =>
              m.userUid === userUid
                ? {
                    ...m,
                    branchIds,
                    // The hidden ones are untouched by a save, so the true
                    // count moves by exactly what changed here.
                    branchCount: branchIds.length + Math.max(0, m.branchCount - m.branchIds.length),
                  }
                : m,
            ),
          },
    );
  }

  private setSaving(userUid: string, saving: boolean): void {
    this.savingUids.update((current) => {
      const next = new Set(current);
      saving ? next.add(userUid) : next.delete(userUid);

      return next;
    });
  }

  // ---- inviting -----------------------------------------------------------

  protected openInvite(): void {
    this.inviteForm.reset({ roleInSchool: SCHOOL_ROLE.hr, fullName: '', email: '', designationText: '' });

    // A new colleague starts with the head office ticked when there is one —
    // the commonest answer, and one that stops somebody being invited into a
    // school they cannot see any of.
    const head = this.campuses().find((c) => c.isHeadOffice);
    this.inviteBranchIds.set(new Set(head ? [head.branchId] : []));

    this.inviteOpen.set(true);
  }

  protected toggleInviteCampus(branchId: number, checked: boolean): void {
    this.inviteBranchIds.update((current) => {
      const next = new Set(current);
      checked ? next.add(branchId) : next.delete(branchId);

      return next;
    });
  }

  protected readonly inviteHelp = computed(() => {
    const role = this.inviteForm.controls.roleInSchool.value;

    return ASSIGNABLE_ROLES.find((r) => r.value === Number(role))?.help ?? '';
  });

  protected async sendInvite(): Promise<void> {
    if (this.inviteForm.invalid) {
      this.inviteForm.markAllAsTouched();
      return;
    }

    const branchIds = [...this.inviteBranchIds()];

    /*
      ⚠️ Somebody invited onto no campus signs in to an empty school. It is
      allowed — a colleague may be added before their campus exists — but it is
      never what somebody meant by accident, so it is confirmed rather than
      warned about afterwards.
    */
    if (this.showCampusScope() && branchIds.length === 0) {
      const ok = await this.confirm.ask({
        title: 'Invite with no campus?',
        message:
          'They will be able to sign in but will not see any campus, or any of its jobs and applicants, ' +
          'until you give them one.',
        confirmText: 'Invite anyway',
      });

      if (!ok) {
        return;
      }
    }

    const value = this.inviteForm.getRawValue();
    this.inviting.set(true);

    this.team
      .invite({
        email: value.email.trim(),
        fullName: value.fullName.trim() || null,
        designationText: value.designationText.trim() || null,
        roleInSchool: Number(value.roleInSchool),
        branchIds,
      })
      .subscribe({
        next: (result) => {
          this.inviting.set(false);
          this.inviteOpen.set(false);

          if (result.alreadyOnTeam) {
            this.toast.info(`${result.email} is already on your team — nothing was changed.`);
          } else if (result.existingAccountAttached) {
            // The retry path. No second email can be sent: only the hash of the
            // first invite token was ever stored.
            this.toast.warning(
              `${result.email} already had an account, and it is now on your team. If they never received the ` +
                'original invitation, ask them to use "forgot password".',
              10000,
            );
          } else {
            this.toast.success(`Invitation sent to ${result.email}.`);
          }

          this.load();
        },
        error: () => this.inviting.set(false),
      });
  }

  // ---- editing a colleague ------------------------------------------------

  protected openEdit(member: TeamMember): void {
    this.editForm.reset({
      fullName: member.fullName ?? '',
      designationText: member.designationText ?? '',
      roleInSchool: member.roleInSchool,
    });

    /*
      🔴 The owner's role is frozen, their name is not.

      Every membership provisioning created has no name — it never had one to
      record — so an owner who could not edit their own row could never put
      their name on this screen at all.
    */
    if (member.isOwner) {
      this.editForm.controls.roleInSchool.disable();
    } else {
      this.editForm.controls.roleInSchool.enable();
    }

    this.editing.set(member);
  }

  protected saveEdit(): void {
    const member = this.editing();

    if (member === null || this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return;
    }

    const value = this.editForm.getRawValue();
    this.savingEdit.set(true);

    this.team
      .saveRole(member.userUid, {
        // getRawValue includes the disabled control, so an owner's role goes
        // back unchanged rather than as undefined.
        roleInSchool: Number(value.roleInSchool),
        fullName: value.fullName.trim() || null,
        designationText: value.designationText.trim() || null,
      })
      .subscribe({
        next: () => {
          this.savingEdit.set(false);
          this.editing.set(null);
          this.toast.success('Saved.');
          this.load();
        },
        error: () => this.savingEdit.set(false),
      });
  }

  // ---- removing -----------------------------------------------------------

  protected async remove(member: TeamMember): Promise<void> {
    const name = this.displayName(member);

    const ok = await this.confirm.ask({
      title: `Remove ${name}?`,
      message:
        'They will be signed out and will not be able to reach this school again. Everything they did stays ' +
        'on record — jobs they posted and applicants they handled keep their name. You can invite them back ' +
        'later, and their campuses come back with them.',
      confirmText: 'Remove access',
      danger: true,
    });

    if (!ok) {
      return;
    }

    this.setSaving(member.userUid, true);

    this.team.remove(member.userUid).subscribe({
      next: () => {
        this.setSaving(member.userUid, false);
        this.toast.success(`${name} no longer has access.`);
        this.load();
      },
      error: () => this.setSaving(member.userUid, false),
    });
  }

  protected reinvite(member: TeamMember): void {
    // Re-inviting a removed colleague revives the same membership row, with the
    // campuses it had. That is the undo for a removal.
    this.inviteForm.reset({
      fullName: member.fullName ?? '',
      email: member.email,
      designationText: member.designationText ?? '',
      roleInSchool: member.isOwner ? SCHOOL_ROLE.hr : member.roleInSchool,
    });

    this.inviteBranchIds.set(new Set(member.branchIds));
    this.inviteOpen.set(true);
  }

  /**
   * The message for a field, once somebody has actually been in it.
   *
   * ⚠️ Takes the control rather than a form-plus-name pair: the two forms have
   * different shapes, so `get(name)` across a union of them is not typed and
   * would need a cast — which is how a renamed control becomes a silently
   * missing error message.
   */
  protected fieldError(
    control: AbstractControl | null,
    messages: Record<string, string>,
  ): string | undefined {
    if (!control || control.valid || !control.touched) {
      return undefined;
    }

    for (const [key, message] of Object.entries(messages)) {
      if (control.hasError(key)) {
        return message;
      }
    }

    return 'Check this field.';
  }

  protected readonly skeletonRows = Array.from({ length: 4 }, (_, i) => i);
}
