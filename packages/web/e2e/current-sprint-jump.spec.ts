/**
 * E2E for the "Jump to current sprint" first-class chrome action (#1594).
 *
 * Golden path: from a non-board project route, both the pinned TopBar control and
 * the top-ranked ⌘K action drop the user straight onto today's active sprint
 * board (scoped via `?sprint=`). Edge: with no active sprint, neither affordance
 * appears — no dead chrome, no stray palette entry.
 *
 * All API calls are route-mocked; no server required.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-cs-00000000-0000-0000-0000-000000001594';
const SPRINT_ID = 'sprint-atlas-4';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Atlas',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
    agile_features: true,
    methodology: 'HYBRID',
  },
];

function sprintFixture(id: string, name: string, state: string) {
  return {
    id,
    server_version: 1,
    short_id: name.replace(/\s/g, ''),
    short_id_display: `SP-${name.replace(/\s/g, '')}`,
    name,
    goal: '',
    notes: '',
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
    state,
    target_milestone: null,
    capacity_points: null,
    wip_limit: null,
    exclude_from_velocity: false,
  };
}

async function setup(
  page: Page,
  opts: { sprints: ReturnType<typeof sprintFixture>[] },
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: opts.sprints.length,
        next: null,
        previous: null,
        results: opts.sprints,
      }),
    }),
  );
  // Land on a non-board project route so a jump is a real navigation to the board.
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  // Shell mounted (⌘K listener attached, TopBar rendered).
  await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
}

test.describe('jump to current sprint (#1594)', () => {
  test('the pinned control lands on the active sprint board', async ({ page }) => {
    await setup(page, { sprints: [sprintFixture(SPRINT_ID, 'Atlas 4', 'ACTIVE')] });

    const control = page.getByRole('button', { name: /go to current sprint: Atlas 4/i });
    await expect(control).toBeVisible();
    await control.click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/board\\?sprint=${SPRINT_ID}`));
  });

  test('the ⌘K action is top-ranked and lands on the active sprint board', async ({ page }) => {
    await setup(page, { sprints: [sprintFixture(SPRINT_ID, 'Atlas 4', 'ACTIVE')] });

    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    // Cold (no query) the sprint jump leads — it is the first option, so Enter runs it.
    const option = dialog.getByRole('option', { name: /Current sprint — Atlas 4/ });
    await expect(option).toBeVisible();
    await page.getByRole('combobox').press('Enter');

    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/board\\?sprint=${SPRINT_ID}`));
  });

  test('no active sprint → no pinned control and no ⌘K sprint entry', async ({ page }) => {
    // Only a PLANNED sprint (no ACTIVE) and the cross-team lens defaults to empty.
    await setup(page, { sprints: [sprintFixture('sprint-atlas-5', 'Atlas 5', 'PLANNED')] });

    await expect(page.getByRole('button', { name: /go to current sprint/i })).toHaveCount(0);

    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Current sprint —/ })).toHaveCount(0);
  });
});
