import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiAppShellComponent } from 'jp-shared/ui';

import { SchoolContextService } from '../core/school-context.service';

/**
 * School chrome.
 *
 * Nothing here but the shared shell and this app's section label — the
 * navigation comes from GET /api/menus, which returns only the rows for this
 * user's type (decision 2.37). That is what makes three apps able to share one
 * shell component without any of them knowing about the others' screens.
 *
 * ⚠️ One thing is loaded here rather than by a screen: the school itself.
 * GroupType decides whether the Branches entry belongs in the navigation at all
 * (2.10), and jp_sso — which issues the menu — has never heard of it. Loading
 * the profile once at the shell means the entry is right on the first paint of
 * every screen, not only after somebody has visited the profile page.
 *
 * A failure is ignored on purpose: the menu simply shows everything the server
 * permitted, which is what it did before this existed.
 */
@Component({
  selector: 'app-school-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiAppShellComponent],
  templateUrl: './school-layout.component.html',
  styleUrl: './school-layout.component.scss',
})
export class SchoolLayoutComponent {
  private readonly context = inject(SchoolContextService);

  constructor() {
    this.context.load().subscribe({ error: () => undefined });
  }
}
