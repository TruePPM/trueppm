/**
 * Sprint windows drawn on the schedule canvas (#2738, ADR-0803).
 *
 * The band itself is canvas paint on an `aria-hidden` layer, so a spec cannot
 * assert its pixels. What it CAN assert — and what actually matters — is that
 * the band's model reaches the user by every route the feature promises:
 *
 *  - the ARIA overlay names the sprint window a banded row sits in, and stays
 *    silent on rows no band covers (the non-visual carrier, WCAG 1.1.1);
 *  - the legend explains the mark, in the ONE legend the delivery-mode
 *    vocabulary already lives in (#2727/#2737) rather than a second one;
 *  - the Display menu can turn the window off — a presentation toggle, not a
 *    view switch: the bars, the outline and the links are all still there.
 *
 * The fixture is deliberately hybrid: a gated phase and a sprint-driven phase
 * in one plan, with a dependency crossing between them. That crossing is the
 * claim the whole issue exists to make, so it is asserted, not assumed.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-band-0000-0000-0000-000000002738';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Hybrid Plan',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(
  id: string,
  wbs: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
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
    ...extra,
  };
}

const SPRINT_ID = 'e2e-sprint-0000-0000-0000-000000002738';

// One plan: a gated phase, then a scrum phase whose whole subtree is committed
// to Sprint 4. The band covers the second phase and nothing else.
const TASKS = [
  row('g1', '1', 'Site preparation'),
  row('g2', '2', 'Foundation pour', {
    early_start: '2026-04-13',
    early_finish: '2026-04-17',
    planned_start: '2026-04-13',
  }),
  row('p3', '3', 'Control software', { is_summary: true, delivery_mode: 'scrum' }),
  row('t31', '3.1', 'Sensor driver', {
    parent_id: 'p3',
    delivery_mode: 'scrum',
    sprint: SPRINT_ID,
    early_start: '2026-04-20',
    early_finish: '2026-04-24',
    planned_start: '2026-04-20',
  }),
  // Deliberately finishes AFTER the window closes on May 1 — a commitment that
  // overruns its sprint is the thing a planner reads off the band's right rule.
  row('t32', '3.2', 'Telemetry pipeline', {
    parent_id: 'p3',
    delivery_mode: 'scrum',
    sprint: SPRINT_ID,
    early_start: '2026-04-27',
    early_finish: '2026-05-06',
    planned_start: '2026-04-27',
  }),
];

// The boundary-crossing edge: a gated task drives a sprint-driven one. Nothing
// forks — the band changes no routing, so this link exists exactly as it would
// without it.
const DEPENDENCIES = [
  {
    id: 'dep-1',
    predecessor: 'g2',
    successor: 't31',
    dependency_type: 'FS',
    lag: 0,
    project: PROJECT_ID,
  },
];

const SPRINTS = [
  {
    id: SPRINT_ID,
    server_version: 1,
    short_id: 'SP01',
    short_id_display: 'SP-01',
    name: 'Sprint 4',
    goal: 'Land the control loop',
    notes: '',
    start_date: '2026-04-20',
    finish_date: '2026-05-01',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: null,
    committed_task_count: null,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: null,
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
];

test.describe('Sprint windows on the schedule canvas (#2738)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECT_ID,
      tasks: TASKS,
      dependencies: DEPENDENCIES,
    });
    // Registered after setupApiMocks so it wins the sprints read — the default
    // mock serves an empty list, which would draw no band at all.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: SPRINTS.length, next: null, previous: null, results: SPRINTS }),
      }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('names the sprint window, with its dates, on every row the band covers', async ({
    page,
  }) => {
    await page.goto(BASE_URL);

    // The phase reads from its descendants, so the band starts on the phase row
    // and runs through both children — three rows, one window. The DATES come
    // with the name: membership alone is not what the band tells a planner.
    await expect(
      page.getByRole('option', { name: /Control software.*in Sprint 4 \(Apr 20 – May 1\)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('option', { name: /Sensor driver.*in Sprint 4 \(Apr 20 – May 1\)/ }),
    ).toBeVisible();
  });

  test('announces a task that finishes past the window it sits in', async ({ page }) => {
    await page.goto(BASE_URL);

    // The right-hand window rule is the whole point of drawing the band; a bar
    // crossing it must reach a screen reader as more than "in Sprint 4".
    await expect(
      page.getByRole('option', {
        name: /Telemetry pipeline.*in Sprint 4 \(Apr 20 – May 1\), finishes after the sprint window/,
      }),
    ).toBeVisible();
  });

  test('stays silent about sprints on the gated rows', async ({ page }) => {
    await page.goto(BASE_URL);

    const gated = page.getByRole('option', { name: /^Site preparation/ });
    await expect(gated).toBeVisible();
    await expect(gated).toHaveAttribute('aria-label', /^(?!.*Sprint).*$/);
  });

  test('the gated and sprint halves stay one plan — the crossing link survives', async ({
    page,
  }) => {
    await page.goto(BASE_URL);

    // A band is paint, not a container: the dependency from the gated phase into
    // the sprint-driven one is announced exactly as any other edge would be.
    const target = page.getByRole('option', { name: /Sensor driver/ });
    await expect(target).toBeVisible();
    const describedBy = await target.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy ?? ''}`)).toContainText('Foundation pour');
  });

  test('the legend explains the band, in the one legend the modes already use', async ({
    page,
  }) => {
    await page.goto(BASE_URL);

    const body = page.getByTestId('schedule-legend-body');
    await expect(body.getByText('Sprint window')).toBeVisible();
    // Same list as Scrum/Kanban — a second legend would re-introduce the "two
    // views" reading the band exists to deny.
    await expect(body.getByText('Scrum')).toBeVisible();
    await expect(page.getByTestId('schedule-legend')).toHaveCount(1);
  });

  test('Display can turn the window off without changing anything else', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Sensor driver/ })).toBeVisible();

    await page.getByRole('button', { name: /^Display/ }).click();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Sprint windows' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    // Not a view switch: the rows, the bars and the links are all still here.
    await expect(page.getByRole('option', { name: /Sensor driver/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^Site preparation/ })).toBeVisible();
    // And the Display badge says a chart element is hidden, so nobody is left
    // wondering where the band went.
    await expect(page.getByRole('button', { name: /Display, 1 active filter/ })).toBeVisible();
  });

  test('the hidden-window choice survives a reload', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByRole('button', { name: /^Display/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Sprint windows' }).click();
    await page.keyboard.press('Escape');

    await page.reload();
    await page.getByRole('button', { name: /^Display/ }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Sprint windows' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('the band survives a zoom to Quarter — same canvas, same rows', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Sensor driver.*in Sprint 4/ })).toBeVisible();

    // Zoom out to the Quarter tier. The window is re-derived from the live
    // scales on every paint, so nothing about the band's attribution changes.
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: /zoom out/i }).click();
    }

    await expect(page.getByRole('option', { name: /Sensor driver.*in Sprint 4/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^Site preparation/ })).toBeVisible();
  });
});
