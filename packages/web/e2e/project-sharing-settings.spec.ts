import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Sharing (#283 / #1486).
 *
 * Golden path: active share links render from GET /projects/:id/share-links/.
 * Error path (#3542): a failed GET must read as broken, not as "No share
 * links yet" — `links` falls through to `?? []` on error, which otherwise
 * reads identically to a genuinely empty set.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-sharing-00000000-0000-0000-0000-000000000283';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Orion',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300, // ADMIN
  role_label: 'Project Admin',
};

const FIXTURE_LINK = {
  id: 'link-1',
  content_kind: 'board',
  token_prefix: 'sample-pfx-1',
  label: 'Client board',
  show_assignees: false,
  show_milestone_dates: true,
  created_by: 'Alice',
  created_at: '2026-05-01T00:00:00Z',
  expires_at: null,
  revoked_at: null,
  access_count: 4,
  last_accessed_at: null,
  is_active: true,
  is_expired: false,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);

  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([ADMIN_MEMBERSHIP]) }),
  );
}

test.describe('Project Settings → Sharing (#283 / #1486)', () => {
  test('golden path — renders an active board share link', async ({ page }) => {
    await setup(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/share-links/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FIXTURE_LINK]) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings#sharing`);

    const sharing = page.getByRole('region', { name: 'Sharing', exact: true });
    await expect(sharing.getByText('Client board')).toBeVisible();
  });

  // Before the fix, `links` fell through to `?? []` on a failed GET, which
  // read identically to "No share links yet" — a lie on a 500, not a stall,
  // but the user still had no error and no way forward.
  test('a failed share-links GET surfaces Retry, not "No share links yet"', async ({ page }) => {
    await setup(page);
    let requestCount = 0;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/share-links/`, (r) => {
      requestCount += 1;
      // The query client retries a failed GET once before settling into
      // `isError` (src/lib/queryClient.ts).
      if (requestCount <= 2) {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'boom' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([FIXTURE_LINK]),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings#sharing`);

    const sharing = page.getByRole('region', { name: 'Sharing', exact: true });
    await expect(sharing.getByText("Couldn't load share links.")).toBeVisible();
    await expect(sharing.getByText(/No share links yet/i)).not.toBeVisible();

    await sharing.getByRole('button', { name: 'Retry' }).click();
    await expect(sharing.getByText('Client board')).toBeVisible();
  });
});
