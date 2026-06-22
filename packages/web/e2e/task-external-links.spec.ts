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
  custom_title: string;
  labels: string[];
  status: string;
  fetched_at: string | null;
  description: string;
  thumbnail_url: string;
  preview_type: string;
  display_order: number;
  server_version: number;
}

/** Provider key for a URL — mirrors the server's host detection (#637, #571). */
function detectProviderForMock(url: string): string {
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitlab.com')) return 'gitlab';
  if (/(drive|docs|sheets|slides)\.google\.com/.test(url)) return 'google_drive';
  if (url.includes('dropbox.com')) return 'dropbox';
  if (url.includes('box.com')) return 'box';
  if (url.includes('onedrive.live.com') || url.includes('sharepoint.com')) return 'onedrive';
  return 'generic';
}

/** Stub the task-link endpoints with a stateful in-memory array. */
async function stubLinks(
  page: Page,
  opts: {
    initial?: LinkRow[];
    refreshStatus?: number;
    refreshBody?: unknown;
    /** Overrides merged into the row on a 200 refresh (default: a git merged status). */
    refreshResult?: Partial<LinkRow>;
  } = {},
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
        ...(opts.refreshResult ?? {}),
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
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        url: string;
        custom_title?: string;
        labels?: string[];
      };
      // Mirror the server: normalize a scheme-less URL to https:// (#970).
      const normalized = /:\/\//.test(body.url) ? body.url : `https://${body.url}`;
      const row: LinkRow = {
        id: `link-${links.length + 1}`,
        url: normalized,
        provider: detectProviderForMock(normalized),
        title: '',
        custom_title: body.custom_title ?? '',
        labels: body.labels ?? [],
        status: 'unknown',
        fetched_at: null,
        description: '',
        thumbnail_url: '',
        preview_type: '',
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
  // External links lives under the Files tab in the redesigned drawer (#962) —
  // switch to it, then expand the section (the non-first section starts collapsed).
  await drawer.getByRole('tab', { name: 'Files' }).click();
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
    await expect(section.getByRole('note')).toContainText(/cloud-file links show a preview/i);

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

  test('#970: bare URL + custom title + labels', async ({ page }) => {
    await stubLinks(page);
    const section = await openDrawerLinksSection(page);

    // A scheme-less URL is accepted (detect hint shows) — #970.
    const input = section.getByLabel('Add a link URL');
    await input.fill('github.com/acme/api/pull/12');
    await expect(section.getByText(/GitHub detected/i)).toBeVisible();

    // Title + labels are revealed once a URL is entered.
    await section.getByLabel('Link title').fill('Design spec');
    const labelInput = section.getByLabel('Add a label');
    await labelInput.fill('spec');
    await labelInput.press('Enter');

    await section.getByRole('button', { name: 'Add', exact: true }).click();

    // The row uses the custom title (not the raw URL) and shows the label chip.
    const row = section.getByRole('listitem', { name: 'Link: Design spec' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: /Design spec/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/api/pull/12',
    );
    await expect(row.getByRole('list', { name: 'Labels' }).getByText('spec')).toBeVisible();
  });

  test('error path: refresh without a credential offers a Connect shortcut', async ({ page }) => {
    await stubLinks(page, {
      initial: [
        {
          id: 'link-1',
          url: 'https://github.com/acme/api/pull/9',
          provider: 'github',
          title: '',
          custom_title: '',
          labels: [],
          status: 'unknown',
          fetched_at: null,
          description: '',
          thumbnail_url: '',
          preview_type: '',
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
          custom_title: '',
          labels: [],
          status: 'unknown',
          fetched_at: null,
          description: '',
          thumbnail_url: '',
          preview_type: '',
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

  test('#571: a cloud-file link unfurls to a preview card on refresh', async ({ page }) => {
    await stubLinks(page, {
      initial: [
        {
          id: 'link-drive',
          url: 'https://docs.google.com/spreadsheets/d/abc/edit',
          provider: 'google_drive',
          title: '',
          custom_title: '',
          labels: [],
          status: 'unknown',
          fetched_at: null,
          description: '',
          thumbnail_url: '',
          preview_type: '',
          display_order: 0,
          server_version: 1,
        },
      ],
      // The refresh unfurls OpenGraph: title + description + a spreadsheet type.
      refreshResult: {
        status: 'unknown',
        title: 'Q3 Budget',
        description: 'Quarterly budget projections',
        preview_type: 'spreadsheet',
      },
    });
    const section = await openDrawerLinksSection(page);

    const row = section.getByRole('listitem', { name: /Link:/ });
    await expect(row).toBeVisible();
    // Before refresh: no status pill (a file has no lifecycle) and no preview text.
    await expect(row.getByText('UNKNOWN')).toHaveCount(0);
    await expect(row.getByText('Quarterly budget projections')).toHaveCount(0);

    // Refresh → preview card: title, description, and a neutral type chip.
    await row.getByRole('button', { name: /Refresh/i }).click();
    await expect(row.getByRole('link', { name: /Q3 Budget/ })).toBeVisible();
    await expect(row.getByText('Quarterly budget projections')).toBeVisible();
    await expect(row.getByLabel('File type: Spreadsheet')).toBeVisible();
  });
});
