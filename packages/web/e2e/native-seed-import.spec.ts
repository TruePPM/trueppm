import { test, expect } from '@playwright/test';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * Native TruePPM seed import E2E (#1611, ADR-0222).
 *
 * The create-from-import dialog's "TruePPM" format tile is a real choice in the
 * standalone (Sidebar) entry: picking it swaps the accepted file type to .json
 * and imports the native canonical seed through POST /programs/import/, which
 * re-materializes a whole program. Golden path: pick TruePPM → upload .json →
 * import → land on the new program's overview. Error path: a validation 400
 * surfaces the server's line-level report inline.
 */

const NEW_PROGRAM_ID = 'e2e-imported-program-0000-0000-000000001611';

// A minimal native seed body. The server is fully mocked here, so the exact
// contents are irrelevant to the assertions — the dropzone only checks the
// .json extension and size before the mocked import responds.
const SEED_JSON = JSON.stringify({
  schema_version: '1.0',
  program: { slug: 'atlas', name: 'Atlas', methodology: 'HYBRID' },
  projects: [{ slug: 'web', name: 'Web', tasks: [] }],
});

async function openImportDialog(page: import('@playwright/test').Page) {
  // Seed the auth store so the shell renders instead of redirecting to login.
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await setupCatchAll(page);
  await setupApiMocks(page);
  // Programs list — feeds both the /programs index and the sidebar section.
  await page.route('**/api/v1/programs/', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    }
    return route.continue();
  });

  await page.goto('/programs');

  // The New-project / Import affordances now live behind the rail's Tier-3
  // "Browse projects and programs" switcher (#1642) — open it first.
  const browse = page.getByRole('button', { name: 'Browse projects and programs' });
  await expect(browse).toBeVisible();
  await browse.click();

  const importButton = page.getByRole('button', { name: 'Import a project from a file' });
  await expect(importButton).toBeVisible();
  await importButton.click();

  const dialog = page.getByRole('dialog', { name: 'Import a project' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('imports a native TruePPM .json seed and lands on the new program overview', async ({
  page,
}) => {
  const dialog = await openImportDialog(page);

  // Registered AFTER openImportDialog (which registers the catch-all) so this
  // more-specific route wins — Playwright checks routes last-registered first.
  // Import endpoint returns the created program; the modal navigates to it.
  await page.route('**/api/v1/programs/import/', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: NEW_PROGRAM_ID,
        name: 'Atlas',
        code: 'atlas',
        methodology: 'HYBRID',
      }),
    }),
  );

  // Pick the native TruePPM format — now a real, selectable tile.
  const truePpmTile = dialog.getByRole('radio', { name: /Native export/ });
  await truePpmTile.click();
  await expect(truePpmTile).toHaveAttribute('aria-checked', 'true');
  // The file-type section swaps to the canonical JSON seed.
  await expect(dialog.getByText('Canonical TruePPM seed')).toBeVisible();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page).toHaveURL(`/programs/${NEW_PROGRAM_ID}/overview`);
});

test('shows the server line-level validation report when a seed is rejected', async ({ page }) => {
  const dialog = await openImportDialog(page);

  // After setup, so this specific route wins over the catch-all.
  await page.route('**/api/v1/programs/import/', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: ['$.projects[0].tasks[0].assignee: unknown account "ghost"'],
      }),
    }),
  );

  await dialog.getByRole('radio', { name: /Native export/ }).click();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText('unknown account "ghost"');
  // The user stays in the dialog and can retry with a different file.
  await expect(dialog.getByRole('button', { name: 'Try a different file' })).toBeVisible();
});
