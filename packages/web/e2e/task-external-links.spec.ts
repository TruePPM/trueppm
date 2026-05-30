/**
 * Git-aware task links — drawer "External links" section (#637).
 *
 * Golden path: open a task drawer, paste a GitHub URL (provider auto-detected),
 * add it (badge shows UNKNOWN until refreshed), then refresh to a live status.
 * Error path: refreshing a link whose provider has no connected credential
 * surfaces a "Connect" affordance instead of an error.
 *
 * The schedule + drawer are rendered via the shared fixtures; the /links/
 * endpoints are stubbed with a small stateful mock per-spec.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-links-00000000-0000-0000-0000-000000000637';
const TASK_ID = 'tl1';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Links Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

interface LinkRow {
  id: string;
  url: string;
  provider: string;
  title: string;
  status: string;
  fetched_at: string | null;
  display_order: number;
  server_version: number;
}

/** Stub the task-link endpoints with a stateful in-memory array. */
async function stubLinks(
  page: Page,
  opts: { initial?: LinkRow[]; refreshStatus?: number; refreshBody?: unknown } = {},
): Promise<void> {
  let links: LinkRow[] = opts.initial ? JSON.parse(JSON.stringify(opts.initial)) : [];
  const base = `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/links/`;

  // Refresh — register first so the more specific glob below doesn't shadow it.
  await page.route(`${base}*/refresh/`, (route) => {
    const status = opts.refreshStatus ?? 200;
    if (status !== 200) {
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(
          opts.refreshBody ?? {
            detail: 'Connect your github account to refresh this link.',
            code: 'credential_required',
            provider: 'github',
            requires_credential: true,
          },
        ),
      });
    }
    const id = new URL(route.request().url()).pathname.match(/links\/([^/]+)\/refresh/)?.[1];
    const idx = links.findIndex((l) => l.id === id);
    if (idx >= 0) {
      links[idx] = {
        ...links[idx],
        status: 'merged',
        title: 'Land it',
        fetched_at: new Date().toISOString(),
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(links[idx]),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await page.route(`${base}*/`, (route) => {
    if (route.request().method() === 'DELETE') {
      const id = new URL(route.request().url()).pathname.match(/links\/([^/]+)\//)?.[1];
      links = links.filter((l) => l.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });

  await page.route(base, (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { url: string };
      const row: LinkRow = {
        id: `link-${links.length + 1}`,
        url: body.url,
        provider: body.url.includes('github.com')
          ? 'github'
          : body.url.includes('gitlab.com')
            ? 'gitlab'
            : 'generic',
        title: '',
        status: 'unknown',
        fetched_at: null,
        display_order: links.length,
        server_version: 1,
      };
      links.push(row);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(row),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(links),
    });
  });
}

async function openDrawerLinksSection(page: Page): Promise<Locator> {
  // The schedule view does not consume the `?task=` query param (no
  // useSearchParams hook); the drawer opens by clicking the task name in the
  // grid — same pattern as task-collaboration.spec.ts.
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText('Foundation', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Foundation/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  // Expand the External links section (sections render collapsed by default).
  const header = drawer.getByRole('button', { name: 'External links' });
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  // Return the section's region so queries scope to it — the drawer's meta-rail
  // has a "+ Add resource" button that collides with our "Add" under strict mode.
  const section = drawer.getByRole('region', { name: 'External links' });
  await expect(section).toBeVisible();
  return section;
}

test.describe('Task external links (#637)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('golden path: detect, add, then refresh to a live status', async ({ page }) => {
    await stubLinks(page);
    const section = await openDrawerLinksSection(page);

    // Empty state.
    await expect(section.getByRole('note')).toContainText(/Paste a GitLab or GitHub URL/i);

    // Paste a GitHub URL → provider-detect hint appears.
    const input = section.getByLabel('Add a link URL');
    await input.fill('https://github.com/acme/api/pull/5');
    await expect(section.getByText(/GitHub detected/i)).toBeVisible();

    // Add → row appears with the UNKNOWN badge (no fetch on add).
    await section.getByRole('button', { name: 'Add', exact: true }).click();
    const row = section.getByRole('listitem', { name: /Link:/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('UNKNOWN')).toBeVisible();

    // Refresh → live status badge.
    await row.getByRole('button', { name: /Refresh status/i }).click();
    await expect(row.getByText('MERGED')).toBeVisible();
  });

  test('error path: refresh without a credential offers a Connect shortcut', async ({ page }) => {
    await stubLinks(page, {
      initial: [
        {
          id: 'link-1',
          url: 'https://github.com/acme/api/pull/9',
          provider: 'github',
          title: '',
          status: 'unknown',
          fetched_at: null,
          display_order: 0,
          server_version: 1,
        },
      ],
      refreshStatus: 422,
    });
    const section = await openDrawerLinksSection(page);

    const row = section.getByRole('listitem', { name: /Link:/ });
    await row.getByRole('button', { name: /Refresh status/i }).click();

    // The 422 credential_required response surfaces a Connect link, not an error.
    const connect = section.getByRole('link', { name: /Connect github to see status/i });
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute('href', '/me/settings/connected-accounts#github');
  });

  test('security: a stored javascript: URL does not render a clickable anchor (#898)', async ({
    page,
  }) => {
    await stubLinks(page, {
      initial: [
        {
          id: 'link-evil',
          url: 'javascript:alert(document.cookie)',
          provider: 'generic',
          title: 'Click me',
          status: 'unknown',
          fetched_at: null,
          display_order: 0,
          server_version: 1,
        },
      ],
    });
    const section = await openDrawerLinksSection(page);

    const row = section.getByRole('listitem', { name: /Link:/ });
    await expect(row).toBeVisible();
    // The title is still shown as inert text…
    await expect(row.getByText('Click me')).toBeVisible();
    // …but it is NOT a link, so the javascript: URI can never bind to an href.
    await expect(row.getByRole('link', { name: /Click me/ })).toHaveCount(0);
  });
});
