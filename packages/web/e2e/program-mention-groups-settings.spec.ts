import { test, expect } from '@playwright/test';

/**
 * Program Settings → Access → Mention groups E2E (ADR-0248, #516).
 *
 * The program-scoped user-defined @mention group manager, mounted at the bottom
 * of the program Access settings page. Verifies:
 * - The Owner can create a group (POST fires with the typed name; the row renders).
 * - A below-Owner member sees the read state (mute) but no create form.
 */

const ME_ID = 'user-alice';
const OTHER_ID = 'user-sofia';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000516';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  code: '',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 2,
};

const OWNER_MEMBERSHIP = {
  id: 'mem-1',
  server_version: 1,
  program: PROGRAM_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 400,
  role_label: 'Project Admin',
};

const MEMBER_MEMBERSHIP = {
  id: 'mem-2',
  server_version: 1,
  program: PROGRAM_ID,
  user: OTHER_ID,
  user_detail: { id: OTHER_ID, username: 'sofia.p', email: 'sofia@example.com' },
  role: 100,
  role_label: 'Team Member',
};

type Page = import('@playwright/test').Page;

function groupFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grp-1',
    server_version: 1,
    program: PROGRAM_ID,
    name: 'tech-leads',
    description: 'program leads',
    email_default_on: false,
    members: [] as unknown[],
    member_count: 0,
    muted_by_me: false,
    ...overrides,
  };
}

async function setup(
  page: Page,
  opts: { myRole?: number; groups?: unknown[] } = {},
) {
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
  const program = { ...FIXTURE_PROGRAM, my_role: opts.myRole ?? 400 };

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
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
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [program], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(program) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([OWNER_MEMBERSHIP, MEMBER_MEMBERSHIP]),
    }),
  );
  // Mention-groups list (stateful). Registered after setup so it wins the exact
  // URL over the catch-all (Playwright LIFO).
  const groups = [...(opts.groups ?? [])];
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/mention-groups/`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; description?: string };
      const created = groupFixture({
        id: `grp-${groups.length + 1}`,
        name: body.name,
        description: body.description ?? '',
      });
      groups.push(created);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(groups),
    });
  });
}

test.describe('Program Settings → Mention groups', () => {
  test('Owner creates a program mention group and the row renders', async ({ page }) => {
    await setup(page);
    let postBody: { name?: string } | null = null;
    page.on('request', (req) => {
      if (
        req.method() === 'POST' &&
        req.url().includes(`/programs/${PROGRAM_ID}/mention-groups/`)
      ) {
        postBody = req.postDataJSON() as { name?: string };
      }
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);

    const heading = page.getByRole('heading', { name: 'Mention groups' });
    await expect(heading).toBeVisible();
    await expect(page.getByText('No mention groups yet.')).toBeVisible();

    await page.getByPlaceholder('tech-leads').fill('vendor-x');
    await page.getByRole('button', { name: 'New group' }).click();

    await expect.poll(() => postBody?.name).toBe('vendor-x');
    // The refetched list renders the new group row (@vendor-x).
    await expect(page.getByText('@vendor-x')).toBeVisible();
  });

  test('a below-Owner member sees the mute control but no create form', async ({ page }) => {
    await setup(page, { myRole: 100, groups: [groupFixture()] });
    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);

    await expect(page.getByRole('heading', { name: 'Mention groups' })).toBeVisible();
    await expect(page.getByText('@tech-leads')).toBeVisible();
    // Any member may mute a group for themselves…
    await expect(page.getByRole('button', { name: 'Mute' })).toBeVisible();
    // …but a non-Owner gets no create affordance.
    await expect(page.getByPlaceholder('tech-leads')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New group' })).toHaveCount(0);
  });
});
