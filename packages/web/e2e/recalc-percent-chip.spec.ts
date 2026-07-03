/**
 * Inline "Recalc %?" prompt on a duration edit under the `confirm` policy
 * (ADR-0151, issue 1254). Golden path: a build-mode duration edit on a task with
 * progress raises a dismissible inline chip (never a modal); accepting re-sends
 * the edit with the prorated percent_complete. Suppressed path: on a coarse
 * pointer (mobile web) the chip never appears — `confirm` behaves as `keep`.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-recalc-00000000-0000-0000-0000-000000001254';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECT_CONFIRM = {
  id: PROJECT_ID,
  name: 'Recalc Project',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  // The chip reads this off the cached project detail (GET /projects/{id}/).
  effective_task_duration_change_percent_policy: 'confirm',
  task_duration_change_percent_policy: null,
  inherited_task_duration_change_percent_policy: 'confirm',
};

const TASK = {
  id: 'rc1',
  wbs_path: '1',
  name: 'Foundation',
  early_start: '2026-04-05',
  early_finish: '2026-04-09',
  planned_start: '2026-04-05',
  duration: 5,
  percent_complete: 40,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

async function enableBuildMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ schedule_build_mode_v1: true }));
  });
}

async function editDurationTo(page: import('@playwright/test').Page, value: string) {
  await page.locator('[aria-label*="Duration: 5 days"]').first().click();
  const input = page.locator('[data-editing="true"] input');
  await input.fill(value);
  await input.press('Enter');
}

test.describe('Recalc %? inline prompt — confirm policy', () => {
  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROJECT_CONFIRM],
      projectId: PROJECT_ID,
      tasks: [TASK],
    });
  });

  test('golden path: duration edit raises the inline chip; accepting re-sends the prorated %', async ({
    page,
  }) => {
    const patches: Array<Record<string, unknown>> = [];
    await page.route(`**/api/v1/tasks/${TASK.id}/`, (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        patches.push(req.postDataJSON());
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...TASK, ...req.postDataJSON() }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await editDurationTo(page, '10');

    // The prompt is an inline chip (role=status), never a modal dialog.
    const chip = page.getByTestId('recalc-percent-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('role', 'status');
    // 40% on 5d → 10d prorates to 20%.
    await expect(chip).toContainText('20%');

    await page.getByRole('button', { name: /Recalculate percent complete to 20%/i }).click();

    await expect
      .poll(() => patches.some((p) => p.percent_complete === 20))
      .toBeTruthy();
  });

  test('dismissing the chip leaves percent complete unchanged (keep)', async ({ page }) => {
    const patches: Array<Record<string, unknown>> = [];
    await page.route(`**/api/v1/tasks/${TASK.id}/`, (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        patches.push(req.postDataJSON());
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...TASK, ...req.postDataJSON() }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await editDurationTo(page, '10');
    await expect(page.getByTestId('recalc-percent-chip')).toBeVisible();

    // Dismiss via keyboard (Escape) — Keep, no mutation. (Keyboard also avoids the
    // row's hover-revealed properties button intercepting the pointer at the ×.)
    await page.getByRole('button', { name: /Recalculate percent complete to/i }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('recalc-percent-chip')).toHaveCount(0);
    // No percent_complete PATCH was ever sent — only the original duration edit.
    expect(patches.some((p) => 'percent_complete' in p)).toBeFalsy();
  });
});

test.describe('Recalc %? inline prompt — mobile suppressed', () => {
  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    // Force a coarse pointer so the client treats `confirm` as `keep` (ADR-0151).
    await page.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q.includes('pointer: coarse')
          ? ({
              matches: true,
              media: q,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              addListener: () => {},
              removeListener: () => {},
              dispatchEvent: () => false,
            } as unknown as MediaQueryList)
          : orig(q);
    });
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROJECT_CONFIRM],
      projectId: PROJECT_ID,
      tasks: [TASK],
    });
  });

  test('coarse pointer: a duration edit never raises the chip (never a modal, never a block)', async ({
    page,
  }) => {
    await page.route(`**/api/v1/tasks/${TASK.id}/`, (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...TASK, ...req.postDataJSON() }),
        });
      }
      return route.continue();
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await editDurationTo(page, '10');

    // Give the chip a chance to (not) appear, then assert it never did.
    await page.waitForTimeout(300);
    await expect(page.getByTestId('recalc-percent-chip')).toHaveCount(0);
  });
});
