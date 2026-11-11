import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ConfirmDialogService, MasterService, ResolvedAddress, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import {
  UiBadgeComponent,
  UiButtonComponent,
  UiComboboxComponent,
  UiModalComponent,
  lookupsToOptions,
  UiAddressSearchComponent,
} from 'jp-shared/ui';

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
  imports: [
    UiAddressSearchComponent,
    ReactiveFormsModule,
    UiBadgeComponent,
    UiButtonComponent,
    UiComboboxComponent,
    UiModalComponent,
  ],
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

  /*
    SR-3 (G27). The three geography masters as combobox options.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE. `lookupsToOptions(states())`
    written in the binding rebuilds the array on every change-detection pass and
    hands <ui-combobox> a new `options` identity each time — which defeats the
    OnPush it was given.
  */
  protected readonly stateOptions = computed(() => lookupsToOptions(this.states()));
  protected readonly districtOptions = computed(() => lookupsToOptions(this.districts()));
  protected readonly cityOptions = computed(() => lookupsToOptions(this.cities()));

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

    /*
      🔴 SR-3 (G27). THE CASCADE HANGS OFF valueChanges, NOT A DOM EVENT.

      The plain <select> fired a native change event that the template read
      back with $any($event.target).value. <ui-combobox> is a
      ControlValueAccessor: it commits through the form control and emits no DOM
      change event at all, so the reload of the dependent master listens to the
      control that actually changed. `formControlName` is unchanged.

      ⚠️ EVERY PROGRAMMATIC WRITE IS { emitEvent: false }, HERE AND IN THE
      RESETS THAT OPEN THE DIALOG. Clearing districtId with events on would
      re-enter this handler; and opening an existing campus to edit would look
      like somebody had just changed the state, wiping the district and city the
      campus was saved with.
    */
    this.form.controls.stateId.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((stateId) => this.onStateChange(stateId));

    this.form.controls.districtId.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((districtId) => this.onDistrictChange(districtId));

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
    this.form.reset({ isActive: true, branchName: '', branchCode: '' }, { emitEvent: false });
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
    }, { emitEvent: false });

    this.districts.set([]);
    this.cities.set([]);

    /*
      🔴 BOTH DEPENDENT LISTS ARE FETCHED, OR THE SAVED CITY IS INVISIBLE.

      The district and city controls render behind `hasDistricts()` and
      `hasCities()` (2.47), so a list nobody fetched is a control nobody draws.
      Loading only the districts meant opening a campus that HAS a city showed
      no city control at all: the value sat in the form, unreadable and
      unchangeable, until the user re-picked the district to trigger the
      cascade.

      ⚠️ THROUGH loadDistricts / loadCities, NOT THROUGH THE CASCADE HANDLERS.
      Those two do nothing but fill a signal. `onStateChange` and
      `onDistrictChange` also CLEAR the choice below them — correct when a
      person changes a parent, wrong when we are restoring a saved row, and the
      reason the reset above is { emitEvent: false } in the first place.

      ⚠️ NEITHER FETCH WAITS FOR THE OTHER, and under P1 that is the whole
      restore: the saved row carries stateId and districtId together, so both
      parents are known before either request goes out. The registration form
      has a third hop for the same reason in the same shape (district -> towns,
      town -> tehsils, all issued from the saved ids); a campus has no tehsil
      field, so two is all there is here.

      ⚠️ THE SAVED IDS ARE WRITTEN BEFORE THE LISTS ARRIVE, and that is fine:
      <ui-combobox> resolves its text from `options()` through a computed, so a
      value set first renders the moment its options land. What the fetch is
      for is the control EXISTING — `hasDistricts()` / `hasCities()` hide a
      control whose list is empty.
    */
    if (branch.stateId) this.loadDistricts(branch.stateId);
    if (branch.districtId) this.loadCities(branch.districtId);

    this.editing.set(branch);
  }

  /**
   * The state changed, so the district list has to be refetched — and the
   * district and city underneath it are wrong now, so they go.
   *
   * ⚠️ stateId is NOT written back here. The control already holds it: the
   * combobox committed it, which is the thing that woke this up.
   */
  private onStateChange(stateId: number | null): void {
    this.form.patchValue({ districtId: null, cityId: null }, { emitEvent: false });
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

  private onDistrictChange(districtId: number | null): void {
    this.form.patchValue({ cityId: null }, { emitEvent: false });
    this.cities.set([]);

    if (districtId) this.loadCities(districtId);
  }

  /**
   * ⚠️ FETCHES, AND NOTHING ELSE — exactly like `loadDistricts` above.
   *
   * Keeping the clearing in `onDistrictChange` and the fetch here is what lets
   * `openEdit` restore a saved city: it can fill the list without re-entering
   * the cascade that would wipe the value it is trying to show.
   */
  private loadCities(districtId: number): void {
    this.masters.getByParent(MASTER_KEYS.city, districtId).subscribe({
      next: (items) => this.cities.set(items),
      error: () => this.cities.set([]),
    });
  }

  /**
   * An address picked in the search box, written into the campus form.
   *
   * ============================================================================
   * 🔴 THE SEQUENCING IS `openEdit`'s, NOT THE CASCADE HANDLERS'
   * ============================================================================
   * This is the same shape of problem `openEdit` already solves — ids arriving
   * together, and both dependent lists having to exist before their controls are
   * drawn — so it is solved the same way, and the warnings there apply here word
   * for word:
   *
   *   1. one `patchValue`, `{ emitEvent: false }`;
   *   2. both lists emptied, because both belong to parents that just changed;
   *   3. `loadDistricts` / `loadCities` called FROM THE RESOLVED IDS, neither
   *      waiting for the other.
   *
   * 🔴 `{ emitEvent: false }` IS LOAD-BEARING, AND MORE SO HERE THAN ANYWHERE.
   * The cascade hangs off `stateId.valueChanges` and `districtId.valueChanges`
   * (see the constructor), and those handlers CLEAR the level below them.
   * Patching with events on would fire `onStateChange`, which would null the
   * district and city this method has just resolved, and then fire
   * `onDistrictChange` on that null — the campus would end up with a state and
   * nothing else, after the user watched the right answer appear and vanish.
   *
   * 🔴 THE LISTS ARE REFILLED THROUGH loadDistricts / loadCities, which only
   * fetch. The clearing lives in the handlers, and that separation is exactly
   * what lets a restore — `openEdit`'s, or this one — fill a list without
   * re-entering the cascade that would wipe the value it is trying to show.
   *
   * ----------------------------------------------------------------------------
   * ⚠️ THE CAMPUS FORM CANNOT STORE EVERYTHING THE RESOLVE RETURNS
   * ----------------------------------------------------------------------------
   * `address.tehsilId`, `address.areaOrVillage` and `address.googlePlaceId` are
   * DROPPED here, because `SaveBranchBody` and USP_SaveBranch carry no such
   * fields — the same gap the template note by the Town box records. The COLUMNS
   * exist on t_app_school_branches (036_alter_address_columns.sql adds TehsilId,
   * AreaOrVillage and GooglePlaceId); only the contract is missing.
   *
   * 🔴 WRITING THEM INTO THE FORM ANYWAY WOULD BE WORSE THAN DROPPING THEM:
   * `save()` cannot send what the body has no field for, so the school would be
   * told "Campus updated" about facts that were never stored. An unmatched level
   * the search box reports is still reported honestly — the control's note names
   * what our masters did not contain, whichever form it is sitting on.
   *
   * ⚠️ `addressLine1` IS FILLED ONLY WHEN IT IS EMPTY. The provider's street
   * line is a guess; what somebody typed about their own campus is not. And the
   * PIN code is kept when the provider returns none, because Places often
   * answers an establishment with no postal_code and deleting a correct PIN over
   * a third party's silence is the failure this feature must not have.
   */
  protected onAddressResolved(address: ResolvedAddress): void {
    const typedLine1 = this.form.controls.addressLine1.value.trim();

    this.form.patchValue({
      // One place, one set of ids — replaced together, nulls included.
      stateId: address.stateId,
      districtId: address.districtId,
      cityId: address.cityId,
      latitude: address.latitude,
      longitude: address.longitude,

      // ⚠️ The form is nonNullable and these two controls are strings, so a
      // null from the provider becomes '' rather than being written as null.
      addressLine1: typedLine1 ? typedLine1 : address.addressLine1 ?? '',
      pincode: address.pincode ?? this.form.controls.pincode.value,
    }, { emitEvent: false });

    this.districts.set([]);
    this.cities.set([]);

    if (address.stateId) this.loadDistricts(address.stateId);
    if (address.districtId) this.loadCities(address.districtId);
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
