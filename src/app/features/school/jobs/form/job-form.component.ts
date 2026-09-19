import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MasterService, ToastService } from 'jp-shared/core';
import { Lookup, MASTER_KEYS } from 'jp-shared/models';
import { UiMultiSelectComponent } from 'jp-shared/ui';

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
  imports: [FormsModule, RouterLink, UiMultiSelectComponent],
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
    Lookup is {id, code, name}; the multi-select speaks {value, label}. Mapped
    here rather than changing either shape — a master list is a master list, and
    a UI control should not dictate the vocabulary of the data layer.
  */
  protected readonly subjectOptions = computed(() =>
    this.subjects().map((s) => ({ value: s.id, label: s.name })));

  protected readonly classLevelOptions = computed(() =>
    this.classLevels().map((c) => ({ value: c.id, label: c.name })));

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

  protected onSubjectsChange(ids: (string | number)[]): void {
    this.form.subjectIds = ids.map(Number);
  }

  protected onLevelsChange(ids: (string | number)[]): void {
    this.form.classLevelIds = ids.map(Number);
  }
}
