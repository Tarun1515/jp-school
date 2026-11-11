import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiComboboxComponent, UiMultiSelectComponent, lookupsToOptions } from 'jp-shared/ui';

import { SchoolService } from '../../../../core/school.service';
import {
  JOB_FIELD_ERRORS,
  JobDetail,
  JobService,
  SaveJobBody,
  jobRefusalMessage,
} from '../../../../core/job.service';

/**
 * Create or edit a job.
 *
 * ----------------------------------------------------------------------------
 * 🔴 THE LOCKED FIELDS ARE VISIBLY LOCKED, AND THEY SAY WHY
 * ----------------------------------------------------------------------------
 * Once a job is published, the fields a teacher MATCHED on stop being editable:
 * campus, subject, designation, qualification, employment type, location and
 * the experience band. The terms — title, salary, timings, description, closing
 * date — stay open.
 *
 * ⚠️ This is 2.62's "not allowed", not "not yet", so the treatment is
 * different from a disabled action on the dashboard: the controls stay VISIBLE
 * and readable, marked locked, with one line saying why and what to do instead.
 * Removing them entirely would hide what the job actually says; leaving them
 * editable would let somebody fill them in and be refused on save.
 *
 * The server enforces it regardless — JOB_FIELD_LOCKED — and a forced request
 * gets the same refusal whether or not this form drew the lock.
 *
 * ----------------------------------------------------------------------------
 * 🔴 EMPLOYMENT TYPE COMES FROM THE MASTER, LIKE EVERY OTHER DROPDOWN (G26)
 * ----------------------------------------------------------------------------
 * Phase 4B shipped this form WITHOUT the control, because
 * `m_app_employment_types` lives in jp_app and `/api/masters/*` only read
 * jp_mdm — so there was no data source, and hardcoding the five values would
 * have been precisely what decision 2.7 forbids while looking like it worked.
 * The consequence was stated and carried as gap G26: no school could post a
 * Part-time, Contract, Visiting or Temporary vacancy at all.
 *
 * The read now falls through to jp_app's `USP_GetAppMaster` (decision 2.68), so
 * the list arrives from `GET /api/masters/employment-type` exactly like subject
 * and designation do. ⚠️ Nothing here knows or cares which database answered —
 * if you ever find yourself adding a branch for that, the fix belongs on the
 * server.
 *
 * 🔴 Employment type is one of the LOCKED fields. A teacher applied to a
 * Part-time post; turning it Full-time underneath them changes what they
 * applied to. `USP_SaveJob` refuses it with JOB_FIELD_LOCKED regardless of what
 * this form draws.
 */
@Component({
  selector: 'app-job-form',
  standalone: true,
  imports: [FormsModule, RouterLink, UiComboboxComponent, UiMultiSelectComponent],
  templateUrl: './job-form.component.html',
  styleUrl: './job-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobFormComponent {
  private readonly jobs = inject(JobService);
  private readonly masters = inject(MasterService);
  private readonly schools = inject(SchoolService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly jobId = signal<number | null>(null);

  /** 🔴 Server-owned. A draft is open; a published job locks its matching fields. */
  protected readonly locked = signal(false);

  protected readonly subjects = signal<Lookup[]>([]);
  protected readonly designations = signal<Lookup[]>([]);
  protected readonly qualifications = signal<Lookup[]>([]);
  protected readonly classLevels = signal<Lookup[]>([]);
  protected readonly employmentTypes = signal<Lookup[]>([]);
  protected readonly branches = signal<{ branchId: number; branchName: string }[]>([]);

  /** Field-level messages, keyed by field name. Never one generic toast. */
  protected readonly fieldErrors = signal<Record<string, string>>({});

  protected form: SaveJobBody = {
    branchId: 0,
    jobTitle: '',
    subjectId: 0,
    designationId: 0,
    qualificationId: null,
    /*
      ⚠️ Seeded to 1, which is what the column defaults to anyway — NOT a
      hardcoded "Full-time". It is the starting value of a control that the
      master then fills, and `pickDefaultEmploymentType` below replaces it with
      the first row the server actually sent rather than assuming 1 is real.
    */
    employmentTypeId: 1,
    noOfVacancies: 1,
    minExperienceMonths: null,
    maxExperienceMonths: null,
    salaryMin: null,
    salaryMax: null,
    isSalaryNegotiable: false,
    workingDays: null,
    timingFrom: null,
    timingTo: null,
    lastDateToApply: null,
    expectedJoiningDate: null,
    jobDescription: null,
    subjectIds: [],
    classLevelIds: [],
    rowVersion: null,
  };

  protected readonly isEdit = computed(() => this.jobId() !== null);

  /*
    Lookup is {id, code, name}; the controls speak {value, label}. Mapped here
    rather than changing either shape — a master list is a master list, and a UI
    control should not dictate the vocabulary of the data layer.

    SR-3 (G27): through `lookupsToOptions`, which is that map, shared. Three
    hand-rolled copies of one line is how two of them end up disagreeing.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE. The map written in the
    binding rebuilds the array on every change-detection pass and hands the
    OnPush child a new `options` identity each time, which defeats it.
  */
  protected readonly subjectOptions = computed(() => lookupsToOptions(this.subjects()));

  protected readonly designationOptions = computed(() => lookupsToOptions(this.designations()));

  protected readonly qualificationOptions = computed(() => lookupsToOptions(this.qualifications()));

  protected readonly classLevelOptions = computed(() => lookupsToOptions(this.classLevels()));

  /*
    P3 (G27). Employment type was the last plain <select> on this form.

    ⚠️ IT BUYS NO SEARCH BOX AND THAT IS NOT THE POINT. Five rows is below
    `searchFrom` (8), so the combobox opens showing all of them exactly as the
    native list did. What it buys is that there is ONE select in the product:
    the next fix to its keyboard handling or its open-list placement lands here
    too, instead of everywhere except the four boxes nobody remembered. And the
    list is MASTER DATA (2.7 / 2.68) — "five rows" is a fact about today's seed,
    not about the control, and the client may add rows without a deployment.

    ⚠️ COMPUTED, NOT MAPPED INLINE IN THE TEMPLATE — the same reason as the four
    above it: a map written in the binding hands the OnPush child a new
    `options` identity on every change-detection pass.
  */
  protected readonly employmentTypeOptions = computed(() =>
    lookupsToOptions(this.employmentTypes()));

  constructor() {
    const id = this.route.snapshot.paramMap.get('jobId');

    this.masters.get(MASTER_KEYS.subject).subscribe((v) => this.subjects.set(v));
    this.masters.get(MASTER_KEYS.designation).subscribe((v) => this.designations.set(v));
    this.masters.get(MASTER_KEYS.qualification).subscribe((v) => this.qualifications.set(v));
    this.masters.get(MASTER_KEYS.classLevel).subscribe((v) => this.classLevels.set(v));

    /*
      🔴 G26 CLOSED. This is the read Phase 4B could not make, and it goes
      through the SAME MasterService and the same cache as the four above — no
      special case, no second code path, nothing that says "jp_app".
    */
    this.masters.get(MASTER_KEYS.employmentType).subscribe((v) => {
      // Default first, signal second: the signal is what schedules the render,
      // so the form value it renders should already be the corrected one.
      this.pickDefaultEmploymentType(v);
      this.employmentTypes.set(v);
    });

    this.schools.listBranches(false).subscribe((list) => {
      this.branches.set(list.map((b) => ({ branchId: b.branchId, branchName: b.branchName })));

      // Default to the only campus when there is only one — a single-campus
      // school should not be asked to pick from a list of one (2.10).
      if (!this.form.branchId && list.length === 1) this.form.branchId = list[0].branchId;
    });

    if (id && id !== 'new') {
      this.jobId.set(Number(id));
      this.loadJob(Number(id));
    } else {
      this.loading.set(false);
    }
  }

  /**
   * Points a NEW job's employment type at a row the server actually sent.
   *
   * 🔴 Id 1 is Full-time today, and that is a fact about the seed, not a
   * guarantee. 2.47 lets the client deactivate any row they do not want
   * (`Is_Active = 0`, never a DELETE) — the day they retire Full-time, a form
   * initialised to 1 would post an id the master no longer serves, the select
   * would render with nothing chosen, and `USP_SaveJob`'s foreign key would
   * refuse it with a message about a record that does not exist.
   *
   * ⚠️ Only for a NEW job. An existing one carries the type it was saved with,
   * whether or not that row is still active — showing a school something other
   * than what its live job says would be worse than showing a retired value.
   */
  private pickDefaultEmploymentType(available: Lookup[]): void {
    if (this.isEdit() || available.length === 0) {
      return;
    }

    if (!available.some((t) => t.id === this.form.employmentTypeId)) {
      this.form.employmentTypeId = available[0].id;
    }
  }

  private loadJob(jobId: number): void {
    this.jobs.get(jobId).subscribe({
      next: (job: JobDetail) => {
        this.locked.set(job.structuralFieldsLocked);
        this.form = {
          jobId: job.jobId,
          branchId: job.branchId,
          jobTitle: job.jobTitle,
          subjectId: job.subjectId,
          designationId: job.designationId,
          qualificationId: job.qualificationId,
          employmentTypeId: job.employmentTypeId,
          noOfVacancies: job.noOfVacancies,
          minExperienceMonths: job.minExperienceMonths,
          maxExperienceMonths: job.maxExperienceMonths,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          isSalaryNegotiable: job.isSalaryNegotiable,
          cityId: job.cityId,
          stateId: job.stateId,
          workingDays: job.workingDays,
          timingFrom: job.timingFrom,
          timingTo: job.timingTo,
          lastDateToApply: job.lastDateToApply ? job.lastDateToApply.slice(0, 10) : null,
          expectedJoiningDate: job.expectedJoiningDate
            ? job.expectedJoiningDate.slice(0, 10) : null,
          jobDescription: job.jobDescription,
          subjectIds: [...job.subjectIds],
          classLevelIds: [...job.classLevelIds],
          rowVersion: job.rowVersion,
        };
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('That job was not found.');
        this.router.navigate(['/jobs']);
      },
    });
  }

  protected save(): void {
    this.saving.set(true);
    this.fieldErrors.set({});

    /*
      The primary subject is always part of the set. The server writes the whole
      set including it, so a reader of the bridge alone sees every subject —
      two places that must agree is worse than one that repeats itself.
    */
    const body: SaveJobBody = {
      ...this.form,
      subjectIds: [...new Set([this.form.subjectId, ...this.form.subjectIds])].filter(Boolean),
    };

    this.jobs.save(body).subscribe({
      next: (id) => {
        this.saving.set(false);
        this.toast.success(this.isEdit() ? 'Saved.' : 'Draft created.');
        this.router.navigate(['/jobs', id]);
      },
      error: (err) => {
        this.saving.set(false);

        /*
          🔴 A FIELD-LEVEL MESSAGE, NOT ONE TOAST.

          The server returns a distinct code per rule precisely so this mapping
          is possible (2.12). "Please check your input" makes somebody hunt
          through eleven fields; naming the field is the difference between a
          two-second fix and a support call.
        */
        const code: string = err?.error?.code ?? '';
        const mapped = JOB_FIELD_ERRORS[code];

        if (mapped) {
          this.fieldErrors.set({ [mapped.field]: mapped.message });

          return;
        }

        this.toast.error(jobRefusalMessage(code, 'That job could not be saved.'));
      },
    });
  }

  protected fieldError(field: string): string | null {
    return this.fieldErrors()[field] ?? null;
  }

  /*
    🔴 ZERO IS STILL "NOT CHOSEN" — what the placeholder <option [value]="0">
    carried before. <ui-combobox> commits an option's value or null, so null
    lands back on 0 and the body posted is the one the server has always been
    given. The combobox is [required], so nothing in the UI reaches the null
    branch; it is here because the field is typed number and must stay one.
  */
  protected onSubjectChange(subjectId: number | null): void {
    this.form.subjectId = subjectId ?? 0;
  }

  protected onDesignationChange(designationId: number | null): void {
    this.form.designationId = designationId ?? 0;
  }

  /*
    🔴 NULL IS KEPT, NOT FOLDED TO 0 — the opposite of the two handlers above,
    and deliberately so. `@QualificationId` defaults to NULL in `USP_SaveJob`,
    so "no specific requirement" is a real answer the column stores, and that
    is exactly what clearing the combobox has to post. Coercing it to 0 would
    send an id no qualification row has and earn a foreign-key refusal.
  */
  protected onQualificationChange(qualificationId: number | null): void {
    this.form.qualificationId = qualificationId;
  }

  /*
    🔴 NULL NEVER ARRIVES, AND THE GUARD IS STILL RIGHT.

    The control is [required], so <ui-combobox> renders no clear (×) button and
    there is no gesture that commits null — which matches the old `<select>`
    exactly: it had no placeholder row either, because a vacancy is always SOME
    kind of employment. The guard keeps the existing value rather than folding
    to 0 like `onSubjectChange` does: 0 is a real "not chosen" for a subject,
    but `t_app_jobs.EmploymentTypeId` carries a foreign key with no zero row, so
    posting 0 would earn a refusal about a record that does not exist.
  */
  protected onEmploymentTypeChange(employmentTypeId: number | null): void {
    if (employmentTypeId === null) {
      return;
    }

    this.form.employmentTypeId = employmentTypeId;
  }

  protected onSubjectsChange(ids: (string | number)[]): void {
    this.form.subjectIds = ids.map(Number);
  }

  protected onLevelsChange(ids: (string | number)[]): void {
    this.form.classLevelIds = ids.map(Number);
  }
}
