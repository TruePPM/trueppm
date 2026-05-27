import { test, expect } from '@playwright/test';

/**
 * Integration — Task CRUD golden path.
 *
 * Exercises the real API write contract: create, update (rename), and delete
 * a task. Mutations are made via fetch from the browser context (through the
 * Vite proxy → real Django). The UI is reloaded after each write to verify
 * the change persisted rather than relying on optimistic state, keeping this
 * test independent of the WebSocket broadcast path.
 */

const EMAIL = process.env['INTEGRATION_USER_EMAIL'] ?? 'ci@trueppm.test';
const PASSWORD = process.env['INTEGRATION_USER_PASSWORD'] ?? 'ci-integration-pw';
const PROJECT_NAME = 'CI Integration Project';
const TASK_NAME = `integration-task-${Date.now()}`;
const UPDATED_TASK_NAME = `${TASK_NAME}-updated`;

/** Log in and return the JWT access token from localStorage. */
async function loginAndGetToken(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  return page.evaluate<string>(() => {
    const raw = localStorage.getItem('trueppm-auth') ?? '{}';
    const parsed = JSON.parse(raw) as { state?: { accessToken?: string } };
    return parsed?.state?.accessToken ?? '';
  });
}

/** Return the ID of the CI integration project via the real API. */
async function getProjectId(page: import('@playwright/test').Page, token: string): Promise<string> {
  const id = await page.evaluate<string>(async ([tk, name]) => {
    const res = await fetch('/api/v1/projects/', {
      headers: { Authorization: `Bearer ${tk}` },
    });
    const data = (await res.json()) as { results: Array<{ id: string; name: string }> };
    return data.results.find((p) => p.name === name)?.id ?? '';
  }, [token, PROJECT_NAME] as [string, string]);
  expect(id, `Project "${PROJECT_NAME}" not found`).toBeTruthy();
  return id;
}

test.describe('Integration — Task CRUD', () => {
  test('create → update → delete a task against the real API', async ({ page }) => {
    const token = await loginAndGetToken(page);
    const projectId = await getProjectId(page, token);

    // --- CREATE ---
    // Note: page.evaluate() runs in the browser context where Playwright's
    // `expect` is unavailable. Return status with the data and assert outside.
    // Tasks are a flat endpoint (`/api/v1/tasks/`) with `project` in the body —
    // not nested under projects/.
    const created = await page.evaluate<{ ok: boolean; status: number; id: string }>(
      async ([tk, pid, tname]) => {
        const res = await fetch(`/api/v1/tasks/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tk}`,
          },
          body: JSON.stringify({ name: tname, duration: 1, project: pid }),
        });
        const data = res.ok ? ((await res.json()) as { id: string }) : { id: '' };
        return { ok: res.ok, status: res.status, id: data.id };
      },
      [token, projectId, TASK_NAME] as [string, string, string],
    );
    expect(created.ok, `POST /tasks/ failed (${created.status})`).toBe(true);
    expect(created.id, 'Created task should have an ID').toBeTruthy();
    const taskId = created.id;

    // Navigate to schedule and verify the task is visible.
    // .first() guards against the task name surfacing in both the schedule
    // list and the unscheduled gutter (the new task has no plannedStart).
    await page.goto(`/projects/${projectId}/schedule`);
    await expect(page.getByText(TASK_NAME).first()).toBeVisible({ timeout: 10_000 });

    // --- UPDATE ---
    const patchResult = await page.evaluate<{ ok: boolean; status: number }>(
      async ([tk, tid, updatedName]) => {
        const res = await fetch(`/api/v1/tasks/${tid}/`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tk}`,
          },
          body: JSON.stringify({ name: updatedName }),
        });
        return { ok: res.ok, status: res.status };
      },
      [token, taskId, UPDATED_TASK_NAME] as [string, string, string],
    );
    expect(patchResult.ok, `PATCH /tasks/ failed (${patchResult.status})`).toBe(true);

    await page.reload();
    await expect(page.getByText(UPDATED_TASK_NAME).first()).toBeVisible({ timeout: 10_000 });
    // The original name is a substring of the updated name, so an exact match
    // is required — `getByText(name)` defaults to substring matching.
    await expect(page.getByText(TASK_NAME, { exact: true })).toHaveCount(0);

    // --- DELETE ---
    const deleteResult = await page.evaluate<number>(
      async ([tk, tid]) => {
        const res = await fetch(`/api/v1/tasks/${tid}/`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tk}` },
        });
        return res.status;
      },
      [token, taskId] as [string, string],
    );
    // Django returns 204 No Content on successful delete.
    expect(deleteResult).toBe(204);

    await page.reload();
    await expect(page.getByText(UPDATED_TASK_NAME, { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
