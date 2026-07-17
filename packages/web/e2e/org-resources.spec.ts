import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Org-level resource management E2E (issue #155).
 * Covers: /resources page loads, create resource, deactivate, restore,
 * and inline-create from the roster combobox.
 */

const PROJECT_ID = 'e2e-proj-00000000-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Omega Launch',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_RESOURCES = [
  {
    id: 'res-1',
    server_version: 1,
    name: 'Alice Nguyen',
    email: 'alice@example.com',
    job_role: 'Frontend Engineer',
    max_units: '1.00',
    is_deleted: false,
    skills: [],
  },
  {
    id: 'res-2',
    server_version: 1,
    name: 'Bob Carter',
    email: 'bob@example.com',
    job_role: 'Designer',
    max_units: '0.50',
    is_deleted: false,
    skills: [],
  },
];

const FIXTURE_RESOURCES_WITH_DEACTIVATED = [
  ...FIXTURE_RESOURCES,
  {
    id: 'res-3',
    server_version: 2,
    name: 'Charlie Lee',
    email: 'charlie@example.com',
    job_role: 'Engineer',
    max_units: '1.00',
    is_deleted: true,
    skills: [],
  },
];

async function seedAuthAndNavigate(page: import('@playwright/test').Page, path = '/resources') {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'fake-jwt', refreshToken: 'fake-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.goto(path);
}

async function mockResourceRoutes(
  page: import('@playwright/test').Page,
  resources = FIXTURE_RESOURCES,
) {
  const paginated = (results: object[]) => ({
    count: results.length,
    next: null,
    previous: null,
    results,
  });

  // Register the catch-all FIRST (last-registered wins) so unmocked shell
  // endpoints (auth/me, me/work, programs, workspace, token refresh) resolve to
  // a 404 instead of falling through and 401-ing — a 401 on refresh trips the
  // session-expired teardown, which races the resource list and flakes the
  // whole spec (surfaced while wiring inline skill add, issue 1612).
  await setupCatchAll(page);

  // Stateful lists so mutations are reflected in subsequent GET re-fetches.
  const deletedIds = new Set<string>();
  const created: typeof resources = [];

  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({ json: paginated(FIXTURE_PROJECTS) }),
  );
  await page.route('**/api/v1/resources/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') {
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      if (includeDeleted) {
        return route.fulfill({ json: paginated(FIXTURE_RESOURCES_WITH_DEACTIVATED) });
      }
      const active = [...resources, ...created].filter((r) => !deletedIds.has(r.id));
      return route.fulfill({ json: paginated(active) });
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/restore/')) {
      return route.fulfill({
        status: 200,
        json: { ...FIXTURE_RESOURCES_WITH_DEACTIVATED[2], is_deleted: false },
      });
    }
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { name: string };
      const newResource = { id: 'res-new', server_version: 1, name: body.name, email: '', job_role: '', max_units: '1.00', is_deleted: false, skills: [] };
      created.push(newResource);
      return route.fulfill({ status: 201, json: newResource });
    }
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, json: resources[0] });
    }
    if (route.request().method() === 'DELETE') {
      const id = url.pathname.replace(/\/$/, '').split('/').pop() ?? '';
      deletedIds.add(id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  // Stateful resource-skills so an inline add is reflected on the next GET.
  const resourceSkills: object[] = [];
  await page.route('**/api/v1/resource-skills/**', (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        resource: string;
        skill: string;
        proficiency: number;
      };
      const created = {
        id: `rs-${resourceSkills.length + 1}`,
        resource: body.resource,
        skill: body.skill,
        skill_name: body.skill === 'sk-react' ? 'React' : body.skill,
        proficiency: body.proficiency,
      };
      resourceSkills.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: paginated(resourceSkills) });
  });

  // Skill catalog autocomplete for the inline add-skill combobox.
  await page.route('**/api/v1/skills/**', (route) => {
    const search = new URL(route.request().url()).searchParams.get('search')?.toLowerCase() ?? '';
    const catalog = [
      { id: 'sk-react', name: 'React', normalized_name: 'react', category: 'Frontend' },
      { id: 'sk-django', name: 'Django', normalized_name: 'django', category: 'Backend' },
    ];
    return route.fulfill({
      json: paginated(catalog.filter((s) => s.name.toLowerCase().includes(search))),
    });
  });
}

// ---------------------------------------------------------------------------
// Golden path: page loads and shows resource list
// ---------------------------------------------------------------------------

test('resources page shows resource list', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  await expect(page.getByRole('list', { name: /resources/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /alice nguyen/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /bob carter/i })).toBeVisible();
});

test('sidebar has Resources link', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  // Resources now lives in the rail's Tier-3 "Browse projects and programs"
  // switcher (#1642) — open it before asserting the link.
  await page.getByRole('button', { name: 'Browse projects and programs' }).click();
  await expect(page.getByRole('link', { name: /resources catalog/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Create resource
// ---------------------------------------------------------------------------

test('create resource — fills form and submits', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  await page.getByRole('button', { name: '+ Add resource' }).click();
  await page.getByLabel('Name').fill('Maria Chen');
  await page.getByLabel('Email').fill('maria@company.com');

  await page.getByRole('button', { name: 'Create resource' }).click();

  // After creation, the new resource should be selected in the list
  await expect(page.getByRole('button', { name: /maria chen/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Inline add skill (issue 1612)
// ---------------------------------------------------------------------------

test('add a skill from the resource detail panel', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  // Select Alice to open the detail panel.
  await page.getByRole('button', { name: /alice nguyen/i }).click();

  // Expand the inline add-skill control.
  await page.getByRole('button', { name: /\+ add skill/i }).click();

  // Choose a proficiency, then search the catalog and select a skill.
  await page.getByRole('button', { name: 'Expert' }).click();
  await page.getByRole('combobox', { name: /search skills/i }).fill('React');
  await page.getByRole('option', { name: /react/i }).click();

  // The added skill appears as a chip in the Skills list.
  await expect(page.getByText('React', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Deactivate (soft-delete)
// ---------------------------------------------------------------------------

test('deactivate resource — shows confirm and soft-deletes', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  // Select Alice
  await page.getByRole('button', { name: /alice nguyen/i }).click();

  // Click deactivate
  await page.getByRole('button', { name: /⚠ deactivate/i }).click();

  // Confirm dialog appears
  await expect(page.getByText(/deactivate alice nguyen/i)).toBeVisible();
  await page.getByRole('button', { name: /^deactivate$/i }).click();

  // Resource is gone from default list
  await expect(page.getByRole('button', { name: /alice nguyen/i })).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Show deactivated toggle
// ---------------------------------------------------------------------------

test('show deactivated toggle surfaces deactivated resources', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  await expect(page.getByRole('button', { name: /charlie lee/i })).not.toBeVisible();

  await page.getByRole('switch', { name: /show deactivated/i }).click();

  await expect(page.getByRole('button', { name: /charlie lee/i })).toBeVisible();
  await expect(page.getByText('Deactivated', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore deactivated resource', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  // Spy on the restore call so we assert the outcome, not just that the click
  // landed. Registered after mockResourceRoutes so this more-specific route wins.
  let restorePosted = false;
  await page.route('**/api/v1/resources/*/restore/', (route) => {
    restorePosted = route.request().method() === 'POST';
    return route.fulfill({
      status: 200,
      json: { ...FIXTURE_RESOURCES_WITH_DEACTIVATED[2], is_deleted: false },
    });
  });

  await page.getByRole('switch', { name: /show deactivated/i }).click();
  await page.getByRole('button', { name: /charlie lee/i }).click();

  await page.getByRole('button', { name: /restore resource/i }).click();

  await expect.poll(() => restorePosted).toBe(true);
});
