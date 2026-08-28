import { Routes } from '@angular/router';
import { activeAccountGuard, authGuard, guestGuard, unsavedChangesGuard } from 'jp-shared/core';

import { singleCampusGuard } from './core/school-context.service';
import { SchoolLayoutComponent } from './layouts/school-layout.component';

/**
 * Route map for the school app.
 *
 * ----------------------------------------------------------------------------
 * NO APP PREFIX IN THE PATHS
 * ----------------------------------------------------------------------------
 * These used to be /school/dashboard, because one application served all three
 * audiences. Now that each has its own deployment the prefix would just repeat
 * the hostname — school.staffroom.in/school/dashboard reads like a mistake.
 *
 * ⚠️ The seeded menu rows in database/jp_sso/03_seed/005_seed_menus.sql carry
 * the matching RoutePath. Add a route here and add the row in the same commit;
 * a menu row pointing at a route that does not exist is a 404, and a route with
 * no menu row is invisible.
 *
 * Guard order is deliberate and applies everywhere:
 *
 *   authGuard          -> is there a session at all?
 *   activeAccountGuard -> has the account been approved?
 *   permissionGuard    -> may they perform this specific action?
 *
 * roleGuard is gone: this app serves exactly one user type, and the token's
 * utype is checked by AppAccessService before any route renders.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'dashboard',
  },

  // ---- public / unauthenticated -------------------------------------------
  {
    path: 'auth',
    canActivate: [guestGuard],
    children: [
      {
        path: 'login',
        loadComponent: () =>
          import('./features/auth/login/login.component').then((m) => m.LoginComponent),
      },
      {
        // School registration only — there is no user-type toggle, because
        // there is no other kind of account this app can create.
        path: 'register',
        loadComponent: () =>
          import('./features/auth/register/register.component').then((m) => m.RegisterComponent),
      },
      {
        path: 'forgot-password',
        loadComponent: () =>
          import('./features/auth/forgot-password/forgot-password.component').then(
            (m) => m.ForgotPasswordComponent,
          ),
      },
      {
        path: 'reset-password',
        loadComponent: () =>
          import('./features/auth/reset-password/reset-password.component').then(
            (m) => m.ResetPasswordComponent,
          ),
        data: { mode: 'reset' },
      },
      {
        // HR onboarding: a colleague invited by a school owner sets their first
        // password here. Same component as reset — a single-use token from a
        // link plus a new password is the same shape.
        path: 'accept-invite',
        loadComponent: () =>
          import('./features/auth/reset-password/reset-password.component').then(
            (m) => m.ResetPasswordComponent,
          ),
        data: { mode: 'invite' },
      },
      { path: '', pathMatch: 'full', redirectTo: 'login' },
    ],
  },

  // ---- signed in, but not necessarily approved ----------------------------
  {
    path: 'account',
    canActivate: [authGuard],
    children: [
      {
        path: 'status',
        loadComponent: () =>
          import('./features/account/account-status/account-status.component').then(
            (m) => m.AccountStatusComponent,
          ),
      },
      {
        /*
          Registration itself lives under /account, not /auth, and reachable
          while pending on purpose: a school signs up, lands here, and comes
          back to the same URL to finish a draft or replace a document that was
          sent back. Putting it behind the app shell would need an approved
          account to reach the form that gets you approved.
        */
        path: 'register',
        loadComponent: () =>
          import('./features/account/registration/registration.component').then(
            (m) => m.RegistrationComponent,
          ),
        data: { title: 'Register your school' },
      },
      {
        // Reachable while pending on purpose — this is how a school fixes a
        // rejected document without being able to reach anything else.
        path: 'documents',
        loadComponent: comingSoon,
        data: { title: 'My documents' },
      },
      {
        path: 'verify-otp',
        loadComponent: () =>
          import('./features/auth/verify-otp/verify-otp.component').then(
            (m) => m.VerifyOtpComponent,
          ),
      },
      { path: '', pathMatch: 'full', redirectTo: 'status' },
    ],
  },

  // ---- the app itself ------------------------------------------------------
  {
    path: '',
    canActivate: [authGuard, activeAccountGuard],
    component: SchoolLayoutComponent,
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/school/dashboard/dashboard.component').then(
            (m) => m.SchoolDashboardComponent,
          ),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./features/school/profile/school-profile.component').then(
            (m) => m.SchoolProfileComponent,
          ),
        /*
          The profile is five sections long and every one of them holds typed
          text. canDeactivate asks the component whether anything is dirty —
          see unsavedChangesGuard for why it uses the native dialog.
        */
        canDeactivate: [unsavedChangesGuard],
        data: { title: 'School profile' },
      },
      {
        /*
          🔴 singleCampusGuard, not permissionGuard.

          A single-campus school has nothing to manage here (2.10), so it is
          redirected rather than shown a screen with one immovable row. The
          menu entry is hidden too — but hiding a link has never stopped
          anybody typing the URL, which is what this is for.

          It starts working the moment they say they have more than one campus,
          with no migration and no data change.
        */
        path: 'branches',
        canActivate: [singleCampusGuard],
        loadComponent: () =>
          import('./features/school/branches/branches.component').then((m) => m.BranchesComponent),
        data: { title: 'Campuses' },
      },
      /*
        Phase 4B — jobs.

        ⚠️ 'new' is listed BEFORE ':jobId' so it matches as a literal. Angular
        takes the first match, and with the order reversed "/jobs/new" would
        resolve as a job whose id is the string "new".

        No permissionGuard: the SCHOOL_JOBS menu row already carries JOB.VIEW,
        so a person without it never sees the link — and the API refuses
        regardless of what the browser drew. Hiding is presentation; the server
        is the protection.
      */
      {
        path: 'jobs',
        loadComponent: () =>
          import('./features/school/jobs/list/job-list.component').then((m) => m.JobListComponent),
        data: { title: 'Jobs' },
      },
      {
        path: 'jobs/new',
        loadComponent: () =>
          import('./features/school/jobs/form/job-form.component').then((m) => m.JobFormComponent),
        data: { title: 'New job' },
      },
      {
        path: 'jobs/:jobId',
        loadComponent: () =>
          import('./features/school/jobs/form/job-form.component').then((m) => m.JobFormComponent),
        data: { title: 'Edit job' },
      },

      /*
        🔴 /applicants HAS NO ROUTE — removed in 3I.

        It was a static mockup: fifty rows from a fixture file, no HTTP call,
        and one of the two screens that looked the most finished (G6). The
        component is kept for its design under `_design-reference/applicants/`
        and comes back in Phase 5, when there are applications to list.

        Its menu row is hidden too (SCHOOL_APPLICANTS, IsMenuVisible = 0) —
        menus are data (2.37), so a route removed here without the seed change
        would leave every school a sidebar entry that 404s.

        ⚠️ Deliberately NOT a `comingSoon` placeholder. That would be a third
        state — neither the real screen nor honestly absent — and the dashboard
        already says what this section will be and when.
      */

      { path: 'teacher-search', loadComponent: comingSoon, data: { title: 'Find teachers' } },
      { path: 'offers', loadComponent: comingSoon, data: { title: 'Offers' } },
      {
        /*
          The seeded menu row SCHOOL_USERS points at /users and is gated on
          USER.MANAGE, so only an owner sees it in the navigation. The route
          itself is NOT permission-guarded: anybody on the team may look at who
          their colleagues are, and the screen renders read-only for them. The
          server refuses every write without USER.MANAGE regardless.
        */
        path: 'users',
        loadComponent: () =>
          import('./features/school/team/team.component').then((m) => m.TeamComponent),
        data: { title: 'Team' },
      },
      { path: 'notifications', loadComponent: comingSoon, data: { title: 'Notifications' } },
    ],
  },

  // ---- errors --------------------------------------------------------------
  {
    path: 'forbidden',
    loadComponent: () => import('jp-shared/pages').then((m) => m.ForbiddenComponent),
  },
  {
    path: '**',
    loadComponent: () => import('jp-shared/pages').then((m) => m.NotFoundComponent),
  },
];

/** Shared placeholder loader, until each feature lands. */
function comingSoon() {
  return import('jp-shared/pages').then((m) => m.ComingSoonComponent);
}
