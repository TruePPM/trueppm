import { test, expect } from '@playwright/test';

/**
 * Program Settings → External stakeholders E2E (#1658, ADR-0264).
 *
 * The program-scoped external stakeholder registry, mounted as its own section in
 * program settings. Verifies the golden path: a program admin adds a stakeholder
 * (POST fires with the typed name + email; the row renders), then removes it.
 *
 * Every data endpoint the program-settings page reads is mocked with its real
 * response shape (heeding the #1190 catch-all-mock flake lesson); interactions are
 * gated on a "page rendered" heading signal.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000001658';

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
  member_count: 1,
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

type Page = import('@playwright/test').Page;

function stakeholderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stk-1',
    name: 'Jane Client',
    email: 'jane@client.com',
    note: 'VP Sponsor',
    created_by: 'alice',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

async function setup(page: Page, opts: { myRole?: number; stakeholders?: unknown[] } = {}) {
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

  // 401-guard catch-all (list shape). Registered FIRST so specific routes below
  // win under Playwright's LIFO precedence.
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
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([OWNER_MEMBERSHIP]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/mention-groups/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  // Stateful stakeholder registry — list + create + delete. Registered LAST so it
  // wins the exact URL over the catch-all.
  const stakeholders = [...(opts.stakeholders ?? [])] as Record<string, unknown>[];
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/external-stakeholders/`,
    async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          name: string;
          email: string;
          note?: string;
        };
        const created = stakeholderFixture({
          id: `stk-${stakeholders.length + 1}`,
          name: body.name,
          email: body.email,
          note: body.note ?? '',
        });
        stakeholders.push(created);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stakeholders),
      });
    },
  );
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/external-stakeholders/*/`,
    async (route) => {
      if (route.request().method() === 'DELETE') {
        const id = route.request().url().split('/').filter(Boolean).pop();
        const idx = stakeholders.findIndex((s) => s.id === id);
        if (idx >= 0) stakeholders.splice(idx, 1);
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    },
  );
}

test.describe('Program Settings → External stakeholders', () => {
  test('admin adds an external stakeholder and the row renders', async ({ page }) => {
    await setup(page);
    let postBody: { name?: string; email?: string } | null = null;
    page.on('request', (req) => {
      if (
        req.method() === 'POST' &&
        req.url().includes(`/programs/${PROGRAM_ID}/external-stakeholders/`)
      ) {
        postBody = req.postDataJSON() as { name?: string; email?: string };
      }
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    // Page-rendered signal: the section heading appears only after the program +
    // stakeholder reads resolve.
    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();
    await expect(page.getByText('No external stakeholders yet.')).toBeVisible();

    // The settings shell renders every section in one scroll, so scope the form
    // interaction to this section's labeled form region to avoid collisions with
    // other sections' inputs/buttons.
    const form = page.getByRole('form', { name: 'Add external stakeholder' });
    await form.getByPlaceholder('Name').fill('Jane Client');
    await form.getByPlaceholder('email@example.com').fill('jane@client.com');
    await form.getByRole('button', { name: 'Add', exact: true }).click();

    await expect.poll(() => postBody?.email).toBe('jane@client.com');
    await expect(page.getByText('Jane Client')).toBeVisible();
    await expect(page.getByText('jane@client.com')).toBeVisible();
  });

  test('admin removes an external stakeholder', async ({ page }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();
    await expect(page.getByText('Jane Client')).toBeVisible();

    await page.getByRole('button', { name: 'Remove Jane Client' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByText('Jane Client')).toHaveCount(0);
    await expect(page.getByText('No external stakeholders yet.')).toBeVisible();
  });
});
