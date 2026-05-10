import { test, expect, Browser } from '@playwright/test';

/**
 * Integration — WebSocket broadcast.
 *
 * Verifies that a task mutation in one browser context propagates to a second
 * open context without any explicit page reload — the only delivery path is
 * the Django Channels WebSocket broadcast.
 *
 * Both contexts use the same integration user. The mutating context creates a
 * task via fetch (through the Vite proxy → real Django) while the observing
 * context is parked on the same project's schedule view. The new task must
 * appear in the observing context within 15 seconds.
 */

const EMAIL = process.env['INTEGRATION_USER_EMAIL'] ?? 'ci@trueppm.test';
const PASSWORD = process.env['INTEGRATION_USER_PASSWORD'] ?? 'ci-integration-pw';
const PROJECT_NAME = 'CI Integration Project';

async function loginAndGetToken(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  return page.evaluate<string>(() => {
    const raw = localStorage.getItem('trueppm-auth') ?? '{}';
    const parsed = JSON.parse(raw) as { state?: { accessToken?: string } };
    return parsed?.state?.accessToken ?? '';
  });
}

async function getProjectId(page: import('@playwright/test').Page, token: string): Promise<string> {
  return page.evaluate<string>(
    async ([tk, name]) => {
      const res = await fetch('/api/v1/projects/', {
        headers: { Authorization: `Bearer ${tk}` },
      });
      const data = (await res.json()) as { results: Array<{ id: string; name: string }> };
      return data.results.find((p) => p.name === name)?.id ?? '';
    },
    [token, PROJECT_NAME] as [string, string],
  );
}

test.describe('Integration — WebSocket broadcast', () => {
  test(
    'task created in one context appears in another without reload',
    async ({ browser }: { browser: Browser }) => {
      // --- Observer context ---
      const ctx1 = await browser.newContext();
      const observer = await ctx1.newPage();
      const token1 = await loginAndGetToken(observer);
      const projectId = await getProjectId(observer, token1);
      expect(projectId, `Project "${PROJECT_NAME}" not found`).toBeTruthy();

      await observer.goto(`/projects/${projectId}/schedule`);
      // Wait for the seed task to confirm the schedule loaded and WS connected.
      // The seed task name appears in both the schedule list and the unscheduled
      // gutter, so .first() avoids a strict-mode locator collision.
      await expect(observer.getByText('CI Seed Task').first()).toBeVisible({ timeout: 15_000 });

      // --- Mutator context ---
      const ctx2 = await browser.newContext();
      const mutator = await ctx2.newPage();
      const token2 = await loginAndGetToken(mutator);

      const broadcastTaskName = `ws-broadcast-${Date.now()}`;

      await mutator.evaluate<void>(
        async ([tk, pid, tname]) => {
          await fetch(`/api/v1/tasks/`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tk}`,
            },
            body: JSON.stringify({ name: tname, duration: 1, project: pid }),
          });
        },
        [token2, projectId, broadcastTaskName] as [string, string, string],
      );

      // Observer should receive the broadcast and re-render without a reload.
      // .first() guards against the same name appearing in the schedule row and
      // the unscheduled gutter (per the same broadcast event hydrating both).
      await expect(observer.getByText(broadcastTaskName).first()).toBeVisible({ timeout: 15_000 });

      await ctx1.close();
      await ctx2.close();
    },
  );
});
