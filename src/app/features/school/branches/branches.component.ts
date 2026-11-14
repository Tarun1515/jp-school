import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { ConfirmDialogService, MasterService, ResolvedAddress, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import {
  UiBadgeComponent,
  UiButtonComponent,
  UiComboboxComponent,
  UiMapPickerComponent,
  UiModalComponent,
  distanceKm,
  lookupsToOptions,
  UiAddressSearchComponent,
} from 'jp-shared/ui';

import {
  COORDINATE_DECIMALS,
  CoordinateAxis,
  coordinateMessage,
  coordinatePairMessage,
  coordinatePairProblem,
  coordinateProblem,
  roundCoordinate,
} from '../../../core/coordinates';
import { SchoolContextService } from '../../../core/school-context.service';
import { SaveBranchBody, SchoolBranch, SchoolService } from '../../../core/school.service';

/**
 * How far a pin may sit from the stated address before the form asks about it.
 *
 * 🔴 SR-6. Three kilometres is the client's number and it is a QUESTION, not a
 * limit: a campus on a bypass road, or one whose Places result landed on the
 * town centre, is entitled to a pin that far out and keeps it by saying so. The
 * server flags the gap for admin review either way, which is why nothing here
 * refuses.
 */
const FAR_PIN_KM = 3;

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
    UiMapPickerComponent,
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

  // =========================================================================
  // 🔴 SR-6 — THE PIN, THE ANCHOR, AND THE DISTANCE BETWEEN THEM
  // =========================================================================
  /*
    THE ANCHOR is where the address provider put the address the school STATED.
    It is not stored and it is not sent; it exists so the form can measure, and
    so the picker has somewhere to put the pin without being asked.

    THE PIN is `latitude`/`longitude` on the form, and it is the only one of the
    two that survives this dialog.

    ⚠️ THE ANCHOR IS NULL UNLESS THE ADDRESS SEARCH RESOLVED ONE IN THIS
    DIALOG. A saved campus comes back with coordinates and no geocode — the row
    stores where the pin is, never where the address was — so EDITING an
    existing campus has a pin and no anchor until somebody searches for an
    address. That is correct rather than a gap: the distance question was asked
    when the pin was placed, and asking it again against a point we have not got
    would mean inventing one.

    ⚠️ AND TODAY THE ANCHOR IS STILL ALWAYS NULL — BUT NO LONGER FOR THE REASON
    THIS COMMENT USED TO GIVE. It said the provider defaults to `None` and
    <ui-address-search> therefore renders nothing. That was true until the
    client's key went in; `GET /api/address/availability` now answers
    `available: true` and the search box DOES render.

    What is still missing is one layer further out: **Places API (New) is not
    enabled on the client's Google Cloud project**, so a search returns an
    empty list and nothing is ever RESOLVED — and the anchor is set only by
    resolving a suggestion. So the far-pin path is still dark, and the sentence
    that explained why had quietly stopped being the reason.

    The map and the two boxes work regardless, which is why neither depends on
    any of this.

    ----------------------------------------------------------------------------
    🔴 WHY THE PIN IS MIRRORED INTO SIGNALS AT ALL
    ----------------------------------------------------------------------------
    A reactive form is not a signal, and the distance has to be recomputed as
    the numbers change — including as somebody types into the two boxes. So the
    two controls are mirrored here and the computeds below read the mirror.

    🔴 EVERY PROGRAMMATIC WRITE MUST SET THE MIRROR BESIDE IT, because this
    component patches with `{ emitEvent: false }` everywhere and for good reason
    (see the constructor's note on the cascade) — which means `valueChanges`
    does NOT fire for a patch and the mirror would be left holding the previous
    campus's pin. `writePin()` exists so there is one place that does both, and
    nothing else in this file writes those two controls.
  */
  private readonly pinLatitude = signal<number | null>(null);
  private readonly pinLongitude = signal<number | null>(null);

  private readonly anchorLatitude = signal<number | null>(null);
  private readonly anchorLongitude = signal<number | null>(null);

  protected readonly formLatitude = this.pinLatitude.asReadonly();
  protected readonly formLongitude = this.pinLongitude.asReadonly();
  protected readonly pinAnchorLatitude = this.anchorLatitude.asReadonly();
  protected readonly pinAnchorLongitude = this.anchorLongitude.asReadonly();

  /**
   * The pin the school has said it wants to keep, BY ITS COORDINATES.
   *
   * ⚠️ Not a boolean. A flag would mean "they answered the question once", and
   * the next place they drag the pin to is a different question — somebody who
   * confirmed a 4 km pin and then dropped one 40 km out would never be asked
   * again.
   */
  private readonly keptPin = signal<{ latitude: number; longitude: number } | null>(null);

  /**
   * How far the pin is from the stated address, or null when that cannot be
   * known.
   *
   * ⚠️ `distanceKm` IS THE SHARED HELPER AND THAT MATTERS: the admin queue
   * flags the same gap with the same function, and two haversines rounded
   * differently would have the school told 3.0 km and the reviewer shown 2.9.
   */
  protected readonly pinDistanceKm = computed<number | null>(() => {
    const anchorLat = this.anchorLatitude();
    const anchorLng = this.anchorLongitude();
    const lat = this.pinLatitude();
    const lng = this.pinLongitude();

    if (anchorLat === null || anchorLng === null || lat === null || lng === null) {
      return null;
    }

    /*
      ⚠️ `Number.isFinite` ON THE RESULT, WHICH IS THE HELPER'S DOCUMENTED
      CONTRACT: `distanceKm` is garbage-in/NaN-out on purpose, so a missing
      coordinate can never come back as "0 km — your pin is at your address".
      Null is how everything below here says "cannot tell", so a NaN becomes one.
    */
    const km = distanceKm(anchorLat, anchorLng, lat, lng);

    return Number.isFinite(km) ? km : null;
  });

  /**
   * ⚠️ `?? 0` IS THE "NOTHING TO MEASURE FROM" ANSWER, not a default. No
   * anchor, no question — a form that cannot measure must not imply it has.
   */
  protected readonly pinIsFar = computed(() => (this.pinDistanceKm() ?? 0) > FAR_PIN_KM);

  protected readonly needsPinConfirm = computed(() => {
    if (!this.pinIsFar()) return false;

    const kept = this.keptPin();

    return kept === null
      || kept.latitude !== this.pinLatitude()
      || kept.longitude !== this.pinLongitude();
  });

  /** The distance as the sentence says it — one decimal under 10 km. */
  protected readonly pinDistanceLabel = computed(() => {
    const km = this.pinDistanceKm();

    if (km === null) return '';

    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  });

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

    /*
      🔴 SR-6: THE TWO COORDINATES ARE VALIDATED NOW, AND STILL OPTIONAL.

      They have round-tripped since 3C — `SaveBranchBody` and `SchoolBranch`
      both carry them, and USP_SaveBranch stores them — but until SR-6 nothing
      checked what went into the boxes. A longitude typed into the latitude box
      stored a campus somewhere in the Indian Ocean and reported "Campus
      updated", and a value pasted out of a mapping tool with nine decimal
      places stored precision nobody has.

      ⚠️ OPTIONAL IS NOT NEGOTIABLE HERE. A school that never sets a pin is not
      blocked from saving a campus — `coordinate()` passes an empty value
      straight through, and `coordinatePair` only fires when exactly one of the
      two is filled in. The map picker cannot be required for the same reason:
      it may never load.
    */
    latitude: [null as number | null, [coordinate('latitude')]],
    longitude: [null as number | null, [coordinate('longitude')]],
    contactPerson: ['', [Validators.maxLength(150)]],
    contactEmail: ['', [Validators.email, Validators.maxLength(150)]],
    contactMobile: ['', [Validators.pattern(/^[6-9]\d{9}$/)]],
    isActive: [true],
  }, { validators: [coordinatePair] });

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

    /*
      🔴 SR-6. THE MIRROR FOR HAND-TYPED COORDINATES.

      Somebody typing in the two boxes changes the pin, and the distance
      question has to follow them — so the mirror these computeds read is kept
      in step from here.

      ⚠️ THIS CATCHES ONLY THE HAND-TYPED CASE. Every programmatic write in this
      file patches with `{ emitEvent: false }`, so `valueChanges` stays silent
      for all of them; `writePin()` sets the mirror beside the patch, and is the
      only other thing that touches these two controls.

      ⚠️ `?? null` BECAUSE AN EMPTIED NUMBER INPUT CAN COMMIT ''. The control is
      typed `number | null`, but the DOM hands over an empty string when the box
      is cleared, and an empty string is not null to a `=== null` guard.
    */
    this.form.controls.latitude.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((latitude) => this.pinLatitude.set(numberOrNull(latitude)));

    this.form.controls.longitude.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((longitude) => this.pinLongitude.set(numberOrNull(longitude)));

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

    /*
      ⚠️ SR-6. THE RESET IS SILENT, SO THE MIRROR AND THE ANCHOR MUST BE CLEARED
      BY HAND. Without this, "Add a campus" opened holding the pin, the anchor
      and the acknowledgement of whichever campus was edited last — and the
      distance question would have been answered about somewhere else.
    */
    this.clearPinState();

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

    /*
      🔴 SR-6. THE SAVED PIN GOES INTO THE MIRROR; THE ANCHOR STAYS NULL.

      The row stores where the PIN is. It has never stored where the stated
      address geocoded to, so there is nothing here to measure against — and
      pretending the saved pin is also the anchor would make every existing
      campus read as a perfect zero-kilometre match, which is a reassurance we
      have not earned. The anchor appears the moment somebody looks up an
      address in this dialog, and the question starts working then.
    */
    this.clearPinState();
    this.pinLatitude.set(branch.latitude);
    this.pinLongitude.set(branch.longitude);

    this.editing.set(branch);
  }

  /**
   * Writes the pin to the form AND to the mirror, which is the only correct way
   * to set those two controls in this component.
   *
   * 🔴 `{ emitEvent: false }` for the reason the cascade note gives — and it is
   * exactly why the mirror has to be set here: `valueChanges` will not fire.
   */
  private writePin(latitude: number | null, longitude: number | null): void {
    /*
      🔴 ROUNDED, NEVER VALIDATED, BECAUSE NOBODY TYPED THIS.

      Leaflet reports a click as 28.45949658203125 and the address provider
      answers with seven decimal places. Both are correct and neither is the
      school's doing — so putting them through the boxes' precision rule would
      mean dropping a pin on the map and being told the coordinates are
      invalid, by a rule with no way to satisfy it. Typed values ARE judged;
      see the argument at the top of core/coordinates.ts.
    */
    const rounded = { latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) };

    this.form.patchValue(rounded, { emitEvent: false });
    this.pinLatitude.set(rounded.latitude);
    this.pinLongitude.set(rounded.longitude);
  }

  /** The pin, the anchor and the acknowledgement, all back to nothing. */
  private clearPinState(): void {
    this.pinLatitude.set(null);
    this.pinLongitude.set(null);
    this.anchorLatitude.set(null);
    this.anchorLongitude.set(null);
    this.keptPin.set(null);
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

      // ⚠️ The form is nonNullable and these two controls are strings, so a
      // null from the provider becomes '' rather than being written as null.
      addressLine1: typedLine1 ? typedLine1 : address.addressLine1 ?? '',
      pincode: address.pincode ?? this.form.controls.pincode.value,
    }, { emitEvent: false });

    /*
      🔴 SR-6. THE ANCHOR IS SET HERE AND NOWHERE ELSE — this is the only moment
      a geocoded point for the STATED address exists. The pin is set to the same
      point, so the distance is zero and the question stays quiet until somebody
      moves it; `writePin` keeps the mirror in step with the patch.

      ⚠️ THE ACKNOWLEDGEMENT GOES WITH IT. A campus that kept a far pin for the
      old address has answered a question about a place it no longer claims.
    */
    /*
      ⚠️ THE ANCHOR IS ROUNDED LIKE THE PIN `writePin` IS ABOUT TO WRITE, so the
      two are byte-identical and the distance is exactly zero. Rounded one and
      not the other, Places' seventh decimal would read as a few centimetres —
      true, and the sort of "0.0 km away" that makes somebody doubt the number.
    */
    this.anchorLatitude.set(roundCoordinate(address.latitude));
    this.anchorLongitude.set(roundCoordinate(address.longitude));
    this.keptPin.set(null);
    this.writePin(address.latitude, address.longitude);

    this.districts.set([]);
    this.cities.set([]);

    if (address.stateId) this.loadDistricts(address.stateId);
    if (address.districtId) this.loadCities(address.districtId);
  }

  /**
   * A pin dropped on the map.
   *
   * 🔴 SR-6. THE PIN IS THE SAVED VALUE, so this writes the same two controls
   * the address lookup writes and nothing else — one pair of coordinates per
   * campus, whichever of the two produced it.
   *
   * ⚠️ THE ACKNOWLEDGEMENT IS NOT CLEARED HERE AND DOES NOT NEED TO BE:
   * `needsPinConfirm` compares the kept COORDINATES with the current ones, so a
   * new pin is a new question by construction.
   */
  protected onPinPicked(point: { latitude: number; longitude: number }): void {
    this.writePin(point.latitude, point.longitude);
  }

  /** "Keep it" — recorded against the pin it was given for, not as a flag. */
  protected keepFarPin(): void {
    const latitude = this.pinLatitude();
    const longitude = this.pinLongitude();

    if (latitude === null || longitude === null) return;

    this.keptPin.set({ latitude, longitude });
  }

  /**
   * The other answer: put the pin back on the address.
   *
   * ⚠️ IT MOVES THE PIN RATHER THAN CLEARING IT. Clearing would leave somebody
   * who only wanted to undo a drag with no coordinates at all — worse than
   * either the pin they had or the address they stated.
   */
  protected movePinToAddress(): void {
    const latitude = this.anchorLatitude();
    const longitude = this.anchorLongitude();

    if (latitude === null || longitude === null) return;

    this.writePin(latitude, longitude);
    this.keptPin.set(null);
  }

  /**
   * One coordinate box's message.
   *
   * ⚠️ NOT `fieldError` WITH A MESSAGE MAP, because the registration form asks
   * the same question of the same two numbers and the wording has to match. The
   * sentences are in core/coordinates.ts; this maps the control's state onto
   * them, with the same "only once touched" rule every other field here uses.
   */
  protected coordinateFieldError(axis: CoordinateAxis): string | undefined {
    const control = this.form.controls[axis];

    if (control.valid || !control.touched) return undefined;

    const problem = coordinateProblem(control.value, axis);

    return problem === null ? 'Check this field.' : coordinateMessage(axis, problem);
  }

  /**
   * The half-a-pin message, when it applies.
   *
   * ⚠️ SHOWN ONLY ONCE EITHER BOX HAS BEEN TOUCHED, which is the rule
   * `fieldError` uses for every other field here: a message about a box nobody
   * has typed in yet is an accusation about something they have not done.
   */
  protected coordinatePairError(): string | undefined {
    const touched = this.form.controls.latitude.touched || this.form.controls.longitude.touched;

    if (!touched) return undefined;

    const missing = coordinatePairProblem(
      this.form.controls.latitude.value,
      this.form.controls.longitude.value,
    );

    return missing === null ? undefined : coordinatePairMessage(missing);
  }

  /** One campus's saved pin, for the list. Six decimals, or nothing. */
  protected pinLabel(branch: SchoolBranch): string | null {
    if (branch.latitude === null || branch.longitude === null) return null;

    return `${branch.latitude.toFixed(COORDINATE_DECIMALS)}, ${branch.longitude.toFixed(COORDINATE_DECIMALS)}`;
  }

  protected save(): void {
    const target = this.editing();
    if (target === null) return;

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    /*
      🔴 SR-6: THE FAR-PIN QUESTION, ASKED AFTER VALIDATION AND SEPARATELY FROM
      IT.

      It is not a validator, because a pin 5 km from the postal address is not
      INVALID — a campus on a bypass road has one, and the server flags the gap
      for a human either way. So it is its own gate with its own two answers,
      rendered inline in the dialog (never a toast: a toast slides away from the
      map it is asking about and takes both answers with it), and "keep it" lets
      the save straight through.

      ⚠️ AFTER `form.invalid`, so a bad PIN code or a half-entered pin is
      reported first. Two unrelated questions at once is how people answer
      neither.

      ⚠️ AND IT CANNOT FIRE WITHOUT AN ANCHOR, which means it cannot fire at all
      for a campus whose address nobody looked up — see the long note on the
      signals. The question is a check on a geocode, not a gate on saving.
    */
    if (this.needsPinConfirm()) {
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

      /*
        ⚠️ SR-6: THROUGH `numberOrNull`, SO AN EMPTIED BOX SENDS null AND NOT ''.
        Angular's number accessor does commit null for an empty input today,
        which is why this was never a bug — but these two are the only numeric
        text boxes on the form, SR-6 is the change that invites people to clear
        them, and `""` arriving where the contract says `number | null` is the
        sort of thing that is discovered in a server log.

        ⚠️ NO ROUNDING HERE. Anything typed has already been held to six decimal
        places by the validator, and anything the map or the address lookup
        produced was rounded by `writePin` on the way in.
      */
      latitude: numberOrNull(value.latitude),
      longitude: numberOrNull(value.longitude),

      /*
        🔴 THE ANCHOR IS SENT ONLY WHEN THIS EDIT ACTUALLY RESOLVED AN ADDRESS.

        It is where the typed address geocoded to, which is a different fact
        from the pin, and the campus-pin review queue is the distance BETWEEN
        the two. Sending the pin here instead would make every campus exactly
        0 km from itself and leave that queue permanently empty — and an empty
        queue reads as "nothing to review", which is the one failure nobody
        would go looking for.

        ⚠️ null ON AN ORDINARY EDIT, AND THAT IS DELIBERATE: the procedure then
        keeps the stored anchor rather than clearing it. Renaming a campus, or
        dragging its pin, does not un-geocode its address.
      */
      geocodedLatitude: this.anchorLatitude(),
      geocodedLongitude: this.anchorLongitude(),

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

/**
 * A number, or null — never the empty string a cleared number input commits.
 *
 * ⚠️ `Number('')` IS 0, which is why this is not a bare `Number()` call: a
 * school that cleared its latitude box would otherwise have a pin on the
 * equator, and `0` is a perfectly valid latitude so nothing downstream could
 * tell it from a real one.
 */
function numberOrNull(value: number | null): number | null {
  if (value === null || value === undefined || (value as unknown) === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One coordinate, judged by the shared rule.
 *
 * 🔴 ONE ERROR KEY, NOT THREE, AND THE MESSAGE DOES NOT LIVE HERE. The three
 * problems and their wording are in core/coordinates.ts because the
 * registration form asks the same question of the same two numbers, and
 * `coordinateFieldError` turns the problem into the sentence. A validator that
 * carried its own copy of the words would be the second version that goes
 * stale.
 *
 * ⚠️ AN EMPTY VALUE IS VALID — the whole contract of this field. A school that
 * never opens the map, and a school whose map never loads, both save a campus.
 */
function coordinate(axis: CoordinateAxis): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null =>
    coordinateProblem(control.value, axis) === null ? null : { coordinate: true };
}

/**
 * Both coordinates, or neither.
 *
 * ⚠️ A GROUP VALIDATOR RATHER THAN TWO FIELD ONES, because the error belongs to
 * the pair: put on each control, filling the second box would clear one message
 * and leave the other sitting there until that control was touched too. The
 * rule itself — and why half a pin is worse than none — is in
 * core/coordinates.ts.
 */
function coordinatePair(group: AbstractControl): ValidationErrors | null {
  const missing = coordinatePairProblem(group.get('latitude')?.value, group.get('longitude')?.value);

  return missing === null ? null : { coordinatePair: missing };
}
