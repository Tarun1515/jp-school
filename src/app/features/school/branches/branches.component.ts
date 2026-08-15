import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ConfirmDialogService, MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiBadgeComponent, UiButtonComponent, UiModalComponent } from 'jp-shared/ui';

import { SchoolContextService } from '../../../core/school-context.service';
import { SaveBranchBody, SchoolBranch, SchoolService } from '../../../core/school.service';

/**
 * Campus management.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE HEAD OFFICE IS MARKED, NOT DISABLED
 * ----------------------------------------------------------------------------
 * Every school keeps at least one campus — that is the invariant Phases 4 and 5
 * are built on, and the server refuses to delete the head office because of it.
 *
 * So its row has no Remove button at all, and carries a marked rule and a
 * label saying what it is. A greyed-out Remove reads as broken and gets clicked
 * anyway; the same reasoning as the owner row on the team screen (3G).
 *
 * ----------------------------------------------------------------------------
 * THE REFUSALS ARE BUILT NOW, NOT WHEN THEY START FIRING
 * ----------------------------------------------------------------------------
 * USP_DeleteBranch already refuses a campus with jobs or applications against
 * it — written in 3C, deliberately unreachable until Phase 4 creates those
 * tables. This screen displays whatever the server says rather than a message
 * of its own, so the day that check goes live the UI already handles it.
 *
 * ⚠️ That is why nothing here maps a code to hardcoded text. The procedure
 * writes the sentence; showing our own would mean maintaining two versions of
 * every rule and shipping the wrong one the day they diverge.
 */
@Component({
  selector: 'app-branches',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, UiBadgeComponent, UiButtonComponent, UiModalComponent],
  templateUrl: './branches.component.html',
  styleUrl: './branches.component.scss',
})
export class BranchesComponent {
  private readonly schools = inject(SchoolService);
  private readonly context = inject(SchoolContextService);
  private readonly masters = inject(MasterService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly fb = inject(FormBuilder);

  protected readonly branches = signal<SchoolBranch[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly removingId = signal<number | null>(null);

  /** Null when the dialog is closed, a branch when editing, 'new' when adding. */
  protected readonly editing = signal<SchoolBranch | 'new' | null>(null);

  protected readonly states = signal<Lookup[]>([]);
  protected readonly districts = signal<Lookup[]>([]);
  protected readonly cities = signal<Lookup[]>([]);

  /** ⚠️ Empty today (2.47). Same degrade as the profile and registration forms. */
  protected readonly hasDistricts = computed(() => this.districts().length > 0);
  protected readonly hasCities = computed(() => this.cities().length > 0);

  protected readonly headOffice = computed(() => this.branches().find((b) => b.isHeadOffice) ?? null);
  protected readonly others = computed(() => this.branches().filter((b) => !b.isHeadOffice));

  protected readonly dialogTitle = computed(() => {
    const target = this.editing();

    if (target === null) return '';

    return target === 'new' ? 'Add a campus' : `Edit ${target.branchName}`;
  });

  protected readonly form = this.fb.nonNullable.group({
    branchName: ['', [Validators.required, Validators.maxLength(200)]],
    branchCode: ['', [Validators.maxLength(30)]],
    addressLine1: ['', [Validators.maxLength(250)]],
    addressLine2: ['', [Validators.maxLength(250)]],
    stateId: [null as number | null],
    districtId: [null as number | null],
    cityId: [null as number | null],
    pincode: ['', [Validators.pattern(/^\d{6}$/)]],
    latitude: [null as number | null],
    longitude: [null as number | null],
    contactPerson: ['', [Validators.maxLength(150)]],
    contactEmail: ['', [Validators.email, Validators.maxLength(150)]],
    contactMobile: ['', [Validators.pattern(/^[6-9]\d{9}$/)]],
    isActive: [true],
  });

  constructor() {
    this.masters.get(MASTER_KEYS.state).subscribe({
      next: (items) => this.states.set(items),
      error: () => this.states.set([]),
    });

    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);

    this.schools.listBranches().subscribe({
      next: (branches) => {
        this.branches.set(branches);
        this.loading.set(false);
      },
      error: () => {
        this.branches.set([]);
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });
  }

  protected stateName(stateId: number | null): string {
    if (stateId === null) return '—';

    return this.states().find((s) => s.id === stateId)?.name ?? '—';
  }

  /** The address on one line, for the list. Empty parts are dropped, not padded. */
  protected addressLine(branch: SchoolBranch): string {
    return [branch.addressLine1, branch.addressLine2, this.stateNameOrNull(branch.stateId), branch.pincode]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(', ');
  }

  private stateNameOrNull(stateId: number | null): string | null {
    if (stateId === null) return null;

    return this.states().find((s) => s.id === stateId)?.name ?? null;
  }

  // ---- the dialog ---------------------------------------------------------

  protected openAdd(): void {
    this.form.reset({ isActive: true, branchName: '', branchCode: '' });
    this.districts.set([]);
    this.cities.set([]);
    this.editing.set('new');
  }

  protected openEdit(branch: SchoolBranch): void {
    this.form.reset({
      branchName: branch.branchName,
      branchCode: branch.branchCode ?? '',
      addressLine1: branch.addressLine1 ?? '',
      addressLine2: branch.addressLine2 ?? '',
      stateId: branch.stateId,
      districtId: branch.districtId,
      cityId: branch.cityId,
      pincode: branch.pincode ?? '',
      latitude: branch.latitude,
      longitude: branch.longitude,
      contactPerson: branch.contactPerson ?? '',
      contactEmail: branch.contactEmail ?? '',
      contactMobile: branch.contactMobile ?? '',
      isActive: branch.isActive,
    });

    this.districts.set([]);
    this.cities.set([]);

    if (branch.stateId) this.loadDistricts(branch.stateId);

    this.editing.set(branch);
  }

  protected onStateChange(stateId: number | null): void {
    this.form.patchValue({ stateId, districtId: null, cityId: null });
    this.districts.set([]);
    this.cities.set([]);

    if (stateId) this.loadDistricts(stateId);
  }

  private loadDistricts(stateId: number): void {
    this.masters.getByParent(MASTER_KEYS.district, stateId).subscribe({
      next: (items) => this.districts.set(items),
      error: () => this.districts.set([]),
    });
  }

  protected onDistrictChange(districtId: number | null): void {
    this.form.patchValue({ districtId, cityId: null });
    this.cities.set([]);

    if (districtId) {
      this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
        next: (items) => this.cities.set(items),
        error: () => this.cities.set([]),
      });
    }
  }

  protected save(): void {
    const target = this.editing();
    if (target === null) return;

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();

    const body: SaveBranchBody = {
      branchName: value.branchName.trim(),
      branchCode: value.branchCode.trim() || null,
      addressLine1: value.addressLine1.trim() || null,
      addressLine2: value.addressLine2.trim() || null,
      stateId: value.stateId,
      districtId: value.districtId,
      cityId: value.cityId,
      pincode: value.pincode.trim() || null,
      latitude: value.latitude,
      longitude: value.longitude,
      contactPerson: value.contactPerson.trim() || null,
      contactEmail: value.contactEmail.trim() || null,
      contactMobile: value.contactMobile.trim() || null,
      isActive: value.isActive,
    };

    this.saving.set(true);

    const request =
      target === 'new'
        ? this.schools.createBranch(body)
        : // 🔴 RowVersion from the row as it was read. The server refuses a
          // stale one rather than overwriting somebody else's edit.
          this.schools.updateBranch(target.branchId, { ...body, rowVersion: target.rowVersion });

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.toast.success(target === 'new' ? 'Campus added.' : 'Campus updated.');

        /*
          ⚠️ A NEW CAMPUS IS INVISIBLE TO A NON-OWNER UNTIL SOMEBODY GIVES THEM
          ACCESS (2.53). The owner sees it immediately; a branch HR who created
          it would not, and "I made a campus and it vanished" reads as a save
          failure. Said out loud rather than left to be discovered.
        */
        if (target === 'new') {
          this.toast.info(
            'Colleagues scoped to particular campuses will not see this one until you give them access on the Team screen.',
            9000,
          );
        }

        this.load();
        // The profile's branch count and the campus lists elsewhere are stale now.
        this.context.load(true).subscribe({ error: () => undefined });
      },
      error: () => this.saving.set(false),
    });
  }

  // ---- removal ------------------------------------------------------------

  /**
   * Removes a campus, and shows the server's refusal when it will not go.
   *
   * 🔴 The message comes from the response. Three refusals exist — the head
   * office, a stale RowVersion, and (from Phase 4) jobs or applications against
   * the campus — each with its own sentence written where the rule lives. This
   * screen displays it; it does not keep a second copy that could disagree.
   */
  protected async remove(branch: SchoolBranch): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Remove ${branch.branchName}?`,
      message:
        'Anyone who could only see this campus will lose access to it. Jobs and applicants attached to it stay ' +
        'on record.',
      confirmText: 'Remove campus',
      danger: true,
    });

    if (!ok) return;

    this.removingId.set(branch.branchId);

    this.schools.deleteBranch(branch.branchId, branch.rowVersion).subscribe({
      next: () => {
        this.removingId.set(null);
        this.toast.success('Campus removed.');
        this.load();
        this.context.load(true).subscribe({ error: () => undefined });
      },
      error: (error: unknown) => {
        this.removingId.set(null);

        // The interceptor shows the message. Reload anyway on a concurrency
        // refusal: what is on screen is out of date by definition.
        if (codeOf(error) === 'CONCURRENCY_CONFLICT') {
          this.load();
        }
      },
    });
  }

  protected fieldError(control: keyof typeof this.form.controls, messages: Record<string, string>): string | undefined {
    const field = this.form.controls[control];

    if (field.valid || !field.touched) return undefined;

    for (const [key, message] of Object.entries(messages)) {
      if (field.hasError(key)) return message;
    }

    return 'Check this field.';
  }

  protected readonly skeletonRows = [0, 1, 2];
}

/** The response code, never the message text (2.12). */
function codeOf(error: unknown): string | null {
  return (error as { error?: { code?: string } } | null)?.error?.code ?? null;
}
