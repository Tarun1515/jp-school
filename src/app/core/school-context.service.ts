import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { MenuService } from 'jp-shared/core';
import { Observable, catchError, map, of, tap } from 'rxjs';

import { SchoolProfile, SchoolService } from './school.service';

/** 1 = a single campus, 2 = a group of campuses (decision 2.10). */
export const GROUP_TYPE = {
  single: 1,
  group: 2,
} as const;

/** The route a single-campus school must never be shown or land on. */
const BRANCHES_ROUTE = '/branches';

/**
 * The school this session belongs to, loaded once and shared.
 *
 * ----------------------------------------------------------------------------
 * 🔴 WHERE "GroupType = 1 HIDES BRANCHES" IS ACTUALLY APPLIED
 * ----------------------------------------------------------------------------
 * Decision 2.10 says a single-campus school never sees the branch UI. That is
 * three separate places, and the decision is only real if all three agree:
 *
 *   THE MENU — jp_sso issues it and has never heard of GroupType, so the app
 *     tells MenuService to hide the route (a jp-shared hook added in 3F).
 *
 *   THE ROUTE — hiding a link has never stopped anybody typing a URL, so
 *     singleCampusGuard redirects.
 *
 *   THE SCREENS — anything with a campus column or a campus picker asks
 *     isMultiCampus() first.
 *
 * ⚠️ Switching to a group is zero migration (2.10): the school edits one field
 * on its profile, this service reloads, the menu entry appears and the guard
 * stops redirecting. No data changes, because the head-office branch has
 * existed since provisioning.
 */
@Injectable({ providedIn: 'root' })
export class SchoolContextService {
  private readonly schools = inject(SchoolService);
  private readonly menu = inject(MenuService);

  private readonly profileSignal = signal<SchoolProfile | null>(null);

  readonly profile = this.profileSignal.asReadonly();

  /**
   * Whether this school has campuses worth distinguishing.
   *
   * ⚠️ NULL COUNTS AS MULTI. A school that has never answered the question gets
   * the branches UI: showing an extra menu item to a school with one campus is
   * a small annoyance, and hiding campuses from a school that has several is a
   * screen they cannot reach at all. The profile form asks for the answer.
   */
  readonly isMultiCampus = computed(() => this.profileSignal()?.groupType !== GROUP_TYPE.single);

  /** Loads once. Pass true after a save that may have changed GroupType. */
  load(force = false): Observable<SchoolProfile> {
    const cached = this.profileSignal();

    if (cached !== null && !force) {
      return of(cached);
    }

    return this.schools.getProfile().pipe(tap((profile) => this.set(profile)));
  }

  /** Called by the profile screen after a save, so one read serves both. */
  set(profile: SchoolProfile): void {
    this.profileSignal.set(profile);
    this.applyMenuVisibility();
  }

  clear(): void {
    this.profileSignal.set(null);
  }

  private applyMenuVisibility(): void {
    this.menu.hideRoutes(this.isMultiCampus() ? [] : [BRANCHES_ROUTE]);
  }
}

/**
 * Keeps a single-campus school off the branches screen.
 *
 * Redirects rather than showing an empty page or a 403: there is nothing wrong
 * with the request, the screen simply has no meaning for this school. It starts
 * working the moment they say they have more than one campus.
 */
export const singleCampusGuard: CanActivateFn = () => {
  const context = inject(SchoolContextService);
  const router = inject(Router);

  return context.load().pipe(
    map(() => (context.isMultiCampus() ? true : router.parseUrl('/profile'))),

    // ⚠️ A failed profile read must not lock somebody out of a screen they are
    // entitled to. Let them through; the screen itself reports the error, which
    // is a great deal clearer than a silent redirect to somewhere else.
    catchError(() => of(true)),
  );
};
