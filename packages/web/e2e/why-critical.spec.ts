import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';

type Page = import('@playwright/test').Page;

/**
 * "Why critical" — first Details section of the Schedule task drawer (#4892).
 *
 * The driving-chain mock is the real `ScheduleDrivingChain` shape; the schema
 * guard (installed by `setupCatchAll`) validates it against
 * `docs/api/openapi.json` on every fulfill.
 */

const PROJECT_ID = 'e2e-whycrit-0000-0000-0000-000000004892';
const SCHEDULE_URL = `/projects/${PROJECT_ID}/schedule`;

function taskRow(id: string, wbs: string, name: string, extra: Record<string, unknown> = {}) {
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
    assignments: [],
    total_float: 4,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...extra,
  };
}

const TASKS = [
  taskRow('pour', '1', 'Pour foundation', { is_critical: true, total_float: 0 }),
  taskRow('frame', '2', 'Frame walls', { is_critical: true, total_float: 0 }),
  taskRow('loose', '3', 'Paint samples'),
];

function node(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    task_id: id,
    name,
    status: 'NOT_STARTED',
    direction: 'upstream',
    hops: 1,
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    total_float: { value: 0, unit: 'working_days' },
    band: 'critical',
    is_critical: true,
    is_project_finish: false,
    sprint: null,
    ...extra,
  };
}

function chain(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    project_id: PROJECT_ID,
    task_id: 'frame',
    computable: true,
    reason: null,
    project_finish: '2026-06-02',
    depth: 3,
    node_cap: 50,
    truncated: false,
    truncated_reason: null,
    total_links: 2,
    omitted_non_driving_count: 0,
    near_critical_threshold: { value: 10, unit: 'working_days' },
    calendar_id: null,
    nodes: [
      node('frame', 'Frame walls', { direction: 'self', hops: 0, early_finish: '2026-04-17' }),
      node('pour', 'Pour foundation'),
      node('rebar', 'Order rebar', {
        hops: 2,
        band: 'near_critical',
        total_float: { value: 7, unit: 'working_days' },
        is_critical: false,
      }),
    ],
    edges: [
      {
        predecessor_id: 'pour',
        successor_id: 'frame',
        dep_type: 'FS',
        lag: { value: 0, unit: 'calendar_days' },
        is_driving: true,
        via_summary: null,
      },
      {
        predecessor_id: 'rebar',
        successor_id: 'pour',
        dep_type: 'FS',
        lag: { value: 2, unit: 'calendar_days' },
        is_driving: false,
        via_summary: null,
      },
    ],
    _provenance: {
      schema_version: 1,
      engine_version: '0.5.0',
      api_version: '1',
      input_hash: 'sha256:0f',
      computed_at: '2026-04-02T14:02:00Z',
    },
    ...extra,
  };
}

async function setup(page: Page, body: unknown, status = 200): Promise<{ calls: () => number }> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Why Critical Project',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
  });
  await setupTaskStore(page, { tasks: TASKS });
  let calls = 0;
  await page.route(/\/api\/v1\/projects\/[^/]+\/schedule\/driving-chain\//, async (route) => {
    calls += 1;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { calls: () => calls };
}

function section(page: Page) {
  return page.getByTestId('why-critical-section');
}

test.describe('Why critical drawer section', () => {
  test('golden path: sentence, badge, technical detail with unit labels', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('tppm:whyCritical:detailOpen'));
    const { calls } = await setup(page, chain());
    await page.goto(`${SCHEDULE_URL}?task=frame`);

    const s = section(page);
    await expect(s.getByRole('heading', { name: 'Why critical' })).toBeVisible();
    await expect(s).toContainText(
      "Can't start until Pour foundation finishes on Apr 10. A delay to any step in this chain moves it.",
    );
    // Header badge replaces the CP chip.
    await expect(
      page.getByRole('button', { name: "Critical, 0 working days float. Show why it's critical." }),
    ).toHaveText('Critical · 0 wd float');

    // Technical detail: collapsed by default, expands in place.
    const toggle = s.getByRole('button', { name: 'Show technical detail' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(s.getByRole('list', { name: 'Driving chain, nearest first' })).toHaveCount(0);
    await toggle.click();
    const hide = s.getByRole('button', { name: 'Hide technical detail' });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    const list = s.getByRole('list', { name: 'Driving chain, nearest first' });
    await expect(list).toBeVisible();
    await expect(list).toContainText('7 wd float');
    await expect(list).toContainText(
      'Not driving · Finish-to-start into Pour foundation · lag +2 cal d',
    );
    await expect(list).toContainText('Near-critical');
    await expect(s).toContainText('wd = working days (float) · cal d = calendar days (lag)');
    await expect(s).toContainText('Near-critical: ≤ 10 wd float');
    await hide.click();
    await expect(list).toHaveCount(0);
    expect(calls()).toBe(1);
  });

  test('badge deep-links: Details selected, param written, heading focused', async ({ page }) => {
    await setup(page, chain());
    await page.goto(`${SCHEDULE_URL}?task=frame`);
    await expect(section(page)).toBeVisible();
    await page.getByRole('button', { name: /Show why it's critical/ }).click();
    await expect(page).toHaveURL(/drawerSection=why-critical/);
    await expect(section(page).getByRole('heading', { name: 'Why critical' })).toBeFocused();
  });

  test('loading a deep link focuses the section heading', async ({ page }) => {
    await setup(page, chain());
    await page.goto(`${SCHEDULE_URL}?task=frame&drawerSection=why-critical`);
    await expect(section(page).getByRole('heading', { name: 'Why critical' })).toBeFocused();
  });

  test('not computable: sprint-only wording comes from the reason', async ({ page }) => {
    await setup(
      page,
      chain({ computable: false, reason: 'not_in_network', nodes: [], edges: [], total_links: 0 }),
    );
    await page.goto(`${SCHEDULE_URL}?task=frame`);
    await expect(section(page)).toContainText(
      'This task has no dependency links, so nothing in the schedule drives its dates.',
    );
    await expect(section(page).getByRole('button', { name: /technical detail/ })).toHaveCount(0);
  });

  test('truncated: cut line, omissions and the partial marker', async ({ page }) => {
    await setup(
      page,
      chain({
        truncated: true,
        truncated_reason: 'depth',
        depth: 1,
        total_links: 31,
        omitted_non_driving_count: 3,
      }),
    );
    await page.goto(`${SCHEDULE_URL}?task=frame`);
    const s = section(page);
    await expect(s.getByRole('button', { name: 'Show technical detail · partial' })).toBeVisible();
    await s.getByRole('button', { name: /Show technical detail/ }).click();
    await expect(s).toContainText('Chain cut at 1 step back. 2 of 31 links shown.');
    await expect(s).toContainText("3 more links don't drive any dates and aren't listed.");
  });

  test('stale: Refresh keeps content dimmed with the version line visible', async ({ page }) => {
    await setup(page, chain());
    await page.goto(`${SCHEDULE_URL}?task=frame`);
    const s = section(page);
    await expect(s).toContainText('Pour foundation');
    // Hold the second response so the refreshing state is observable.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(/\/schedule\/driving-chain\//, async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(chain()),
      });
    });
    await s.getByRole('button', { name: /Show technical detail/ }).click();
    await s.getByRole('button', { name: 'Refresh why critical' }).click();
    await expect(s.getByText('Updating…')).toBeVisible();
    await expect(s.getByTestId('why-critical-content')).toHaveCSS('opacity', '0.55');
    await expect(s.getByText(/Showing schedule computed 14:02 UTC/)).toBeVisible();
    release();
    await expect(s.getByText('Updating…')).toHaveCount(0);
  });

  test('error state offers Try again', async ({ page }) => {
    await setup(page, { detail: 'boom' }, 500);
    await page.goto(`${SCHEDULE_URL}?task=frame`);
    await expect(section(page)).toContainText("Couldn't load why this task is critical.");
    await expect(section(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('a non-critical task without a deep link shows no section and no badge', async ({
    page,
  }) => {
    const { calls } = await setup(page, chain());
    await page.goto(`${SCHEDULE_URL}?task=loose`);
    await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();
    await expect(section(page)).toHaveCount(0);
    expect(calls()).toBe(0);
  });
});
