# Design reference — not shipped, not routed

Screens kept for their **design**, whose data does not exist yet.

Nothing in here is reachable. There is no route, no menu entry and no import
from `src/app/features`. The Angular build tree-shakes it out: with nothing
importing these files they never enter a bundle, which is checked in
`jp-docs/scripts/verify/dashboards-3i.mjs`.

---

## `applicants/`

The applicants list, built in Phase 1D against **fifty rows of fixture data**
(`applicant.data.ts`) with no HTTP call at all.

🔴 It was one of the two screens that looked the most finished and was entirely
fictional (G6) — which is the dangerous combination in front of a client. Phase
3I removed its route and hid its menu row (`SCHOOL_APPLICANTS`,
`IsMenuVisible = 0`).

**Why it was kept rather than deleted.** A dense screen cannot be designed
against three rows of placeholder text: 50 rows, 8 columns, a filter bar and a
pager at 1440px is what proved the table direction — the margin rule, the roll
as a histogram, ruling instead of zebra striping. That work is still correct and
Phase 5 builds the real screen from it.

**What has to change when applications exist:**

- delete `applicant.data.ts` — it is a fixture, and its warning header says so;
- sorting, filtering and paging move to the server, which `ui-table` already
  expects;
- the component moves back under `features/school/`, gets its route, and
  `SCHOOL_APPLICANTS` goes back to `IsMenuVisible = 1` in the menu seed.

⚠️ Until then, treat every number on it as invented. It is accurate as design
and fictional as data.
