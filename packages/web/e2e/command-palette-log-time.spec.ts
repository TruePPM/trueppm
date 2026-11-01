import { test, expect, type Page } from './fixtures/coverage';
import {
  openCommandPalette,
  paletteSearch,
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  type ProjectFixture,
} from './fixtures';

/**
 * E2E for the ⌘K "Log time on <last task>" quick action (#1211, carved from #647).
 *
 * The last-opened task is a client-side signal (localStorage, keyed by user id), so
 * the specs seed it directly. Golden path: open → action → enter minutes → submit.
 * Edge states: a refused write stays inline and keeps the palette open, a Viewer
 * never sees the action, and focus moves into and back out of the inline form.
 */

const PROJECT: ProjectFixture = { id: 'cmdk-lt-proj', name: 'Apollo Redesign' };
const TASK_ID = 'cmdk-lt-task-1';

async function setup(page: Page, opts: { selfRole?: number; seed?: boolean } = {}): Promise<void> {
  const seed = opts.seed ?? true;
  await page.addInitScript(
    ({ key, value, seedIt }) => {
      if (seedIt) localStorage.setItem(key, value);
    },
    {
      key: 'trueppm:last-task:e2e-user',
      value: JSON.stringify({
        taskId: TASK_ID,
        projectId: PROJECT.id,
        name: 'Wire the settings form',
        ref: 'APO-T-7',
      }),
      seedIt: seed,
    },
  );
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT],
    projectId: PROJECT.id,
    selfRole: opts.selfRole,
  });
  await page.goto('/me/work');
}

const CREATED = {
  id: 'entry-lt-1',
  task: TASK_ID,
  user: 1,
  minutes: 45,
  entry_date: new Date().toISOString().slice(0, 10),
  note: '',
  source: 'manual',
  server_version: 1,
  created_at: new Date().toISOString(),
};

test.describe('command palette: log time on last task', () => {
  test('open → action → minutes → submit logs and closes the palette', async ({ page }) => {
    await setup(page);
    let body: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/*/time-entries/', async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(CREATED),
      });
    });

    const { dialog, search } = await openCommandPalette(page);
    await search.fill('log time');
    const option = dialog.getByRole('option', { name: /Log time on Wire the settings form/ });
    await expect(option).toBeVisible();
    await search.press('Enter');

    const minutes = dialog.getByLabel(/minutes/i);
    await expect(minutes).toBeFocused();
    await minutes.fill('45');
    await minutes.press('Enter');

    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Logged 45m on APO-T-7 · Wire the settings form/)).toBeVisible();
    expect(body).toMatchObject({ minutes: 45 });
  });

  test('a refused write stays inline with the server reason and keeps the palette open', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/tasks/*/time-entries/', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ entry_date: ['Time cannot be logged in the future.'] }),
      }),
    );

    const { dialog, search } = await openCommandPalette(page);
    await search.fill('log time');
    await search.press('Enter');
    const minutes = dialog.getByLabel(/minutes/i);
    await minutes.fill('30');
    await minutes.press('Enter');

    await expect(dialog.getByTestId('cmdk-log-time-error')).toHaveText(
      'Time cannot be logged in the future.',
    );
    await expect(dialog).toBeVisible();
  });

  test('Back returns focus to the search field', async ({ page }) => {
    await setup(page);
    const { dialog, search } = await openCommandPalette(page);
    await search.fill('log time');
    await search.press('Enter');
    await expect(dialog.getByLabel(/minutes/i)).toBeFocused();
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(paletteSearch(page, dialog)).toBeFocused();
  });

  test('the action is absent for a Viewer', async ({ page }) => {
    await setup(page, { selfRole: 1 });
    const { dialog, search } = await openCommandPalette(page);
    await search.fill('log time');
    await expect(dialog.getByText(/No matches/)).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Log time on/ })).toHaveCount(0);
  });

  test('the action is absent when no task has been opened', async ({ page }) => {
    await setup(page, { seed: false });
    const { dialog, search } = await openCommandPalette(page);
    await search.fill('log time');
    await expect(dialog.getByRole('option', { name: /Log time on/ })).toHaveCount(0);
  });
});
