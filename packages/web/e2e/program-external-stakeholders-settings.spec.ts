import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';
import { delayRoute } from './fixtures/cold-load';

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
  my_role_label: 'Program Admin',
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

async function setup(
  page: Page,
  opts: { myRole?: number; stakeholders?: unknown[]; viewerMemberCount?: number } = {},
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

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
  // falling through and 401ing, which trips the token-refresh session
  // teardown and races the page render (#2366). Routes below win.
  await setupCatchAll(page);

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
  // #2529: the reach strip's Viewer arm. Must be mocked with its real OBJECT shape —
  // the catch-all returns the list envelope `{count:0,…}`, which is truthy but has
  // no `viewer_member_count`, so the strip would silently degrade to its
  // count-unavailable state and the assertions below would pass for the wrong reason.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/mention-reach/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        group_key: 'program-stakeholders',
        viewer_member_count: opts.viewerMemberCount ?? 6,
        external_stakeholder_count: (opts.stakeholders ?? []).length,
      }),
    }),
  );

  // Stateful stakeholder registry — list + create + delete. Registered LAST so it
  // wins the exact URL over the catch-all.
  const stakeholders = [...(opts.stakeholders ?? [])] as Record<string, unknown>[];
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/external-stakeholders/`, async (route) => {
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
  });
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/external-stakeholders/*/`, async (route) => {
    const id = route.request().url().split('/').filter(Boolean).pop();
    const idx = stakeholders.findIndex((s) => s.id === id);
    if (route.request().method() === 'DELETE') {
      if (idx >= 0) stakeholders.splice(idx, 1);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (idx >= 0) stakeholders[idx] = { ...stakeholders[idx], ...body };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(idx >= 0 ? stakeholders[idx] : {}),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
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
    // #2529: the empty state states current reach, so the bare string is gone.
    await expect(page.getByRole('status').filter({ hasText: 'No external stakeholders yet' })).toContainText(
      'reaches 6 Viewer-role members in this program.',
    );

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

  // #2530 — the row is editable in place, so fixing a typo no longer costs a
  // remove + re-add (which #1675 would make destructive of verified state).
  test('admin edits an external stakeholder inline', async ({ page }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    let patchBody: { email?: string } | null = null;
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/external-stakeholders/')) {
        patchBody = req.postDataJSON() as { email?: string };
      }
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();
    await expect(page.getByText('jane@client.com')).toBeVisible();

    await page.getByRole('button', { name: 'Edit Jane Client' }).click();
    const form = page.getByRole('form', { name: 'Edit Jane Client' });
    const email = form.getByPlaceholder('email@example.com');

    // A malformed address disables Save and — once the field is left — says why,
    // so no round trip is spent on a typo.
    await email.fill('jane@@nope');
    await email.blur();
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(form.getByRole('alert')).toHaveText('Enter a valid email address.');

    await email.fill('jane@newclient.com');
    await form.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => patchBody?.email).toBe('jane@newclient.com');
    await expect(page.getByText('jane@newclient.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Jane Client' })).toBeVisible();
  });

  test('admin removes an external stakeholder', async ({ page }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();
    await expect(page.getByText('Jane Client')).toBeVisible();

    await page.getByRole('button', { name: 'Remove Jane Client' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByText('Jane Client')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'No external stakeholders yet' })).toBeVisible();
  });

  // #2548: the header and read rows used to force a hard 5-column grid via an
  // inline `gridTemplateColumns` at every breakpoint — on a 375px viewport the
  // fixed "Added by" + actions tracks left ~80px for Name + Email + Note
  // combined, truncating all three. Both now share a `grid-cols-1
  // md:grid-cols-[...]` Tailwind ruler, so the row stacks its cells into one
  // column below `md` and lays them out side by side again at `md` and up.
  test('the read row stacks below md and lays out side by side again above it', async ({
    page,
  }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);
    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();

    const nameMobile = await page.getByText('Jane Client').boundingBox();
    const emailMobile = await page.getByText('jane@client.com').boundingBox();
    expect(nameMobile).not.toBeNull();
    expect(emailMobile).not.toBeNull();
    // Stacked: the email value sits on its own line below the name value...
    expect(emailMobile!.y).toBeGreaterThan(nameMobile!.y + nameMobile!.height - 1);
    // ...and the name value spans most of the row instead of being squeezed
    // into a fixed-width track alongside "Added by" (118px) and actions (116px).
    expect(nameMobile!.width).toBeGreaterThan(250);

    await page.setViewportSize({ width: 1280, height: 800 });
    const nameDesktop = await page.getByText('Jane Client').boundingBox();
    const emailDesktop = await page.getByText('jane@client.com').boundingBox();
    expect(nameDesktop).not.toBeNull();
    expect(emailDesktop).not.toBeNull();
    // Side by side again: name and email share the same row.
    expect(Math.abs(nameDesktop!.y - emailDesktop!.y)).toBeLessThan(4);
  });

  // #2529 — the strip is the page's stated job: state who @program-stakeholders
  // actually reaches. The two arms are never summed (the union #1675 removed from
  // the resolver must not reappear in the UI).
  test('the reach summary states both arms separately and never sums them', async ({ page }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    await expect(page.getByRole('heading', { name: 'External stakeholders' })).toBeVisible();
    await expect(page.getByText('Jane Client')).toBeVisible();

    await expect(page.getByText('1 external contact — listed only.')).toBeVisible();
    await expect(
      page.getByText(/No email or notification is sent to them yet/),
    ).toBeVisible();
    await expect(
      page.getByText(/6 Viewer-role members get an in-app notification/),
    ).toBeVisible();
    // 1 + 6 = 7 — no combined total, and no version number in user-facing copy.
    await expect(page.getByText(/reaches 7|7 people|7 recipients/)).toHaveCount(0);
    await expect(page.getByText(/email delivery is a future, operator-enabled/)).toBeVisible();
  });

  test('the reach summary omits the Viewer clause when the count is unavailable', async ({
    page,
  }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    // A non-Admin is 403'd on the reach read (ADR-0264 §3 floor). Absence beats a
    // wrong figure — the strip must not render 0 or a placeholder.
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/mention-reach/`, (r) =>
      r.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"nope"}' }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    await expect(page.getByText('1 external contact — listed only.')).toBeVisible();
    await expect(page.getByText(/Viewer-role member/)).toHaveCount(0);
  });

  // Rule 248 covers chunk- and query-loading alike (#2431): the loading state is a
  // skeleton ghost, never a bare "Loading…" text line. `delayRoute` forces the cold
  // path so the assertion is deterministic rather than racing a warm query cache.
  test('the loading state is a skeleton ghost, not a bare "Loading…" line', async ({ page }) => {
    await setup(page, { stakeholders: [stakeholderFixture()] });
    await delayRoute(page, `**/api/v1/programs/${PROGRAM_ID}/external-stakeholders/`);

    await page.goto(`/programs/${PROGRAM_ID}/settings/stakeholders`);

    // The named status node is what the wait-for-paint idiom gates on.
    const skeleton = page.getByRole('status', { name: /Loading external stakeholders/i });
    await expect(skeleton).toBeVisible();
    // The forbidden shape: a visible bare "Loading…" string anywhere on the page.
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);

    // …and the skeleton detaches once the delayed read lands.
    await expect(skeleton).toHaveCount(0);
    await expect(page.getByText('Jane Client')).toBeVisible();
  });
});
