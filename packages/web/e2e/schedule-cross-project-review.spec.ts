/**
 * Downstream review of pending cross-project dependency links (#1480, ADR-0120 D2).
 *
 * When another team proposes a cross-project edge against one of this project's
 * tasks, the edge is inert (`pending_acceptance`) until the successor team
 * accepts or rejects it. The successor's own schedule shows a neutral banner
 * that opens a review panel with the upstream D5 card and per-row Accept /
 * Decline.
 *
 * Golden path: a Scheduler on the successor project sees the banner, opens the
 * panel, and Accept POSTs the accept action and clears the banner (stateful
 * mock). Gate: a Member sees the banner but the controls are disabled.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-xproj-0000-0000-0000-000000001480';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Payments',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'down-1',
    wbs_path: '1',
    name: 'Deploy service',
    early_start: '2026-04-06',
    early_finish: '2026-04-08',
    planned_start: '2026-04-06',
    duration: 2,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    external_link_summary: null,
  },
];

const PENDING_DEP = {
  id: 'dep-1',
  predecessor: 'up-1',
  successor: 'down-1',
  dep_type: 'FS',
  lag: 0,
  pending_acceptance: true,
  accepted_by: null,
  accepted_at: null,
  predecessor_card: {
    id: 'up-1',
    title: 'Provision cluster',
    hex_id: 'A-12',
    project_id: 'proj-a',
    project_name: 'Platform',
    is_milestone: false,
    early_start: '2026-04-01',
    early_finish: '2026-04-05',
    is_critical: true,
  },
  successor_card: {
    id: 'down-1',
    title: 'Deploy service',
    hex_id: 'B-7',
    project_id: FIXTURE_PROJECT_ID,
    project_name: 'Payments',
    is_milestone: false,
    early_start: '2026-04-06',
    early_finish: '2026-04-08',
    is_critical: false,
  },
};

function jsonList(results: unknown[]) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
  };
}

/**
 * Override the successor project's `members/?self=true` role. The shared
 * fixture hardcodes Admin (300) for `?self=true`, so a Member-gate assertion
 * needs its own route. useCurrentUserRole reads res.data[0] from a *bare* array
 * (not paginated), so return the row list directly. Registered after
 * setupApiMocks → wins (Playwright matches newest-first).
 */
async function setupSelfRole(page: import('@playwright/test').Page, role: number) {
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/members/**`, (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    const url = new URL(req.url());
    const body =
      url.searchParams.get('self') === 'true' ? [{ id: 'self', role }] : [{ id: 'self', role }];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/**
 * Stateful `/dependencies/` route: returns the pending edge until an accept/reject
 * POST lands, then returns an empty list — so the banner clears after the action
 * (a static mock would falsely keep it visible; CLAUDE.md stateless-mock rule).
 * Registered after setupApiMocks so it wins (Playwright matches newest-first).
 */
async function setupStatefulDeps(page: import('@playwright/test').Page) {
  let resolved = false;
  await page.route('**/api/v1/dependencies/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'POST' && /\/(accept|reject)\/$/.test(url)) {
      resolved = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...PENDING_DEP, pending_acceptance: false }),
      });
    }
    return route.fulfill(jsonList(resolved ? [] : [PENDING_DEP]));
  });
}

test.describe('Cross-project dependency review banner (#1480)', () => {
  test('Scheduler accepts a pending link and the banner clears', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      members: [{ id: 'm1', role: 200 }], // Scheduler → can act
    });
    await setupStatefulDeps(page);
    await setupSelfRole(page, 200); // Scheduler on this successor project

    await page.goto(BASE_URL);
    // Gate on the schedule having rendered before touching the banner.
    await expect(page.getByText('Deploy service').first()).toBeVisible();

    // Banner shows the pending count and opens the review panel.
    const reviewBtn = page.getByRole('button', { name: 'Review', exact: true });
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    const dialog = page.getByRole('dialog', { name: /Review cross-project links/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Provision cluster')).toBeVisible();
    await expect(dialog.getByText(/in Platform/)).toBeVisible();

    // Accept fires the POST and, once the list refetches empty, the banner clears.
    const acceptReq = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/dependencies\/dep-1\/accept\/$/.test(r.url()),
    );
    await dialog.getByRole('button', { name: /Accept cross-project link/ }).click();
    await acceptReq;
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeHidden();
  });

  test('a Member sees the banner but the controls are disabled', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      members: [{ id: 'm2', role: 100 }], // Member → cannot act
    });
    await setupStatefulDeps(page);
    await setupSelfRole(page, 100); // Member on this successor project

    await page.goto(BASE_URL);
    await expect(page.getByText('Deploy service').first()).toBeVisible();
    await page.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog', { name: /Review cross-project links/ });
    await expect(dialog.getByRole('button', { name: /Accept cross-project link/ })).toBeDisabled();
    await expect(dialog.getByText(/Resource Manager or higher/)).toBeVisible();
  });
});
