import { Routes } from '@angular/router';
import { activeAccountGuard, authGuard, guestGuard } from 'jp-shared/core';

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
      { path: 'profile', loadComponent: comingSoon, data: { title: 'School profile' } },
      { path: 'branches', loadComponent: comingSoon, data: { title: 'Branches' } },
      { path: 'jobs', loadComponent: comingSoon, data: { title: 'Jobs' } },
      {
        path: 'applicants',
        loadComponent: () =>
          import('./features/school/applicants/applicants.component').then(
            (m) => m.ApplicantsComponent,
          ),
      },
      { path: 'teacher-search', loadComponent: comingSoon, data: { title: 'Find teachers' } },
      { path: 'offers', loadComponent: comingSoon, data: { title: 'Offers' } },
      { path: 'users', loadComponent: comingSoon, data: { title: 'Team' } },
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
