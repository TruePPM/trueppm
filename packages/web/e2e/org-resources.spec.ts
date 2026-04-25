import { test, expect } from '@playwright/test';

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

  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({ json: paginated(FIXTURE_PROJECTS) }),
  );
  await page.route('**/api/v1/resources/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') {
      // ?include_deleted=true returns the full list
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      const list = includeDeleted ? FIXTURE_RESOURCES_WITH_DEACTIVATED : resources;
      return route.fulfill({ json: paginated(list) });
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/restore/')) {
      return route.fulfill({
        status: 200,
        json: { ...FIXTURE_RESOURCES_WITH_DEACTIVATED[2], is_deleted: false },
      });
    }
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { name: string };
      return route.fulfill({
        status: 201,
        json: { id: 'res-new', server_version: 1, name: body.name, email: '', job_role: '', max_units: '1.00', is_deleted: false, skills: [] },
      });
    }
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, json: resources[0] });
    }
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await page.route('**/api/v1/resource-skills/**', (route) =>
    route.fulfill({ json: paginated([]) }),
  );
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

  await page.getByRole('checkbox', { name: /show deactivated/i }).check();

  await expect(page.getByRole('button', { name: /charlie lee/i })).toBeVisible();
  await expect(page.getByText('Deactivated')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore deactivated resource', async ({ page }) => {
  await mockResourceRoutes(page);
  await seedAuthAndNavigate(page);

  await page.getByRole('checkbox', { name: /show deactivated/i }).check();
  await page.getByRole('button', { name: /charlie lee/i }).click();

  await page.getByRole('button', { name: /restore resource/i }).click();
});
