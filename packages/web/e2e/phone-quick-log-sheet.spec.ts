import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * E2E for the shell v2 phone quick-log sheet (#4762, Pass 1 `phoneLog`): the bottom
 * bar's center button opens a sheet of tasks due today with half-hour steppers.
 * Golden path at 390px, the empty state, a refused write, and the offline-queued state.
 */

const PROJECT_ID = 'e2e-qlsheet-0000-0000-0000-000000000001';
const TASK_A = 'task-qls-aaaa';
const TASK_B = 'task-qls-bbbb';

const task = (id: string, name: string, group: string) => ({
  id,
  short_id: '00000001',
  short_id_display: 'T-1',
  name,
  project_id: PROJECT_ID,
  project_name: 'Atlas Migration',
  program_id: null,
  program_name: null,
  program_color: null,
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: null,
  remaining_points: null,
  due: '2026-11-07',
  due_source: 'planned',
  is_critical: false,
  group,
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 1,
  url: `/projects/${PROJECT_ID}/schedule?task=${id}`,
});

async function setup(page: Page, tasks: ReturnType<typeof task>[]) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Atlas Migration',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
  });
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: tasks,
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: tasks.length,
        server_version_high_water: 1,
      }),
    }),
  );
}

// Scoped to the bottom bar: the top bar's own Log time popover shares the accessible name.
const bar = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Log time' });

test.describe('phone quick-log sheet (#4762)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('golden path: open, step, save posts minutes, focus returns to the button', async ({
    page,
  }) => {
    await setup(page, [
      task(TASK_A, 'Write the spec', 'today'),
      task(TASK_B, 'Later thing', 'upcoming'),
    ]);
    const posts: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/tasks/${TASK_A}/time-entries/`, async (route) => {
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'te-1',
          task: TASK_A,
          minutes: 90,
          entry_date: '2026-11-07',
          note: '',
          source: 'MANUAL',
          server_version: 1,
          created_at: '2026-11-07T10:00:00Z',
        }),
      });
    });

    await page.goto('/me/work');
    const logButton = page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Log time' });
    await expect(logButton).toBeVisible({ timeout: 10_000 });
    await logButton.click();

    const sheet = page.getByRole('dialog', { name: 'Log time' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Write the spec')).toBeVisible();
    await expect(sheet.getByText('Later thing')).toHaveCount(0);

    const inc = sheet.getByRole('button', { name: 'Increase hours on Write the spec' });
    expect((await inc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const dec = sheet.getByRole('button', { name: 'Decrease hours on Write the spec' });
    expect((await dec.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await dec.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    // Keyboard operation: Enter on the focused stepper steps it.
    await inc.focus();
    await page.keyboard.press('Enter');
    await expect(sheet.getByTestId(`quicklog-value-${TASK_A}`)).toHaveText('0.5h');
    for (let i = 0; i < 2; i++) await inc.click();
    await expect(sheet.getByTestId(`quicklog-value-${TASK_A}`)).toHaveText('1.5h');

    await sheet.getByRole('button', { name: 'Save 1.5h' }).click();
    await expect(sheet).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ minutes: 90 });
    await expect(logButton).toBeFocused();
  });

  test('Escape closes the sheet and returns focus to the button', async ({ page }) => {
    await setup(page, [task(TASK_A, 'Write the spec', 'today')]);
    await page.goto('/me/work');
    const logButton = bar(page);
    await logButton.click();
    await expect(page.getByRole('dialog', { name: 'Log time' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Log time' })).toHaveCount(0);
    await expect(logButton).toBeFocused();
  });

  test('empty state links to the timesheet', async ({ page }) => {
    await setup(page, []);
    await page.goto('/me/work');
    await bar(page).click();
    const sheet = page.getByRole('dialog', { name: 'Log time' });
    await expect(sheet.getByTestId('quicklog-empty')).toBeVisible();
    await expect(sheet.getByRole('link', { name: /timesheet/i })).toHaveAttribute(
      'href',
      '/me/timesheet',
    );
  });

  test('a refused write keeps the sheet open with a sibling alert', async ({ page }) => {
    await setup(page, [task(TASK_A, 'Write the spec', 'today')]);
    await page.route(`**/api/v1/tasks/${TASK_A}/time-entries/`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Forbidden' }),
      }),
    );
    await page.goto('/me/work');
    await bar(page).click();
    const sheet = page.getByRole('dialog', { name: 'Log time' });
    await sheet.getByRole('button', { name: 'Increase hours on Write the spec' }).click();
    await sheet.getByRole('button', { name: 'Save 0.5h' }).click();
    await expect(sheet.getByRole('alert')).toContainText('Write the spec');
    await expect(sheet).toBeVisible();
  });

  test('offline: states it will send when online, then the queued write drains on reconnect', async ({
    page,
    context,
  }) => {
    await setup(page, [task(TASK_A, 'Write the spec', 'today')]);
    const posts: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/tasks/${TASK_A}/time-entries/`, async (route) => {
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'te-2',
          task: TASK_A,
          minutes: 30,
          entry_date: '2026-11-07',
          note: '',
          source: 'MANUAL',
          server_version: 1,
          created_at: '2026-11-07T10:00:00Z',
        }),
      });
    });
    await page.goto('/me/work');
    await expect(bar(page)).toBeVisible({ timeout: 10_000 });
    await context.setOffline(true);
    await bar(page).click();
    const sheet = page.getByRole('dialog', { name: 'Log time' });
    await expect(sheet.getByTestId('quicklog-offline')).toContainText('will send when online');
    await sheet.getByRole('button', { name: 'Increase hours on Write the spec' }).click();
    await sheet.getByRole('button', { name: 'Save 0.5h' }).click();
    await expect(sheet).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await context.setOffline(false);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ minutes: 30 });
  });
});
