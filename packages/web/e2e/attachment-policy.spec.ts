import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Attachment policy E2E (ADR-0153, #976).
 *
 * Two surfaces:
 *  1. Golden path — an Admin opens Project Settings and the Attachments section
 *     renders its inheritable File-attachments toggle + Allowed-file-types
 *     control.
 *  2. Disabled state — when the project's resolved policy turns uploads off, the
 *     task drawer's Attachments section keeps listing existing files but replaces
 *     the add-controls with the muted "disabled for this project" note.
 *
 * Every endpoint the page reads is mocked with its real response shape (per the
 * repo rule about catch-all mocks crashing object-shaped endpoints). We gate on a
 * "page rendered" signal (the section heading / drawer dialog) before
 * interacting.
 */

const PROJECT_ID = 'e2e-attach-00000000-0000-0000-0000-000000000976';
const TASK_ID = 't-attach-1';

const FIXTURE_USER = {
  id: 'user-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

/** A project whose attachment policy is server-resolved ON with a small allow-list. */
function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Atlas Migration',
    description: '',
    start_date: '2026-03-02',
    calendar: null,
    estimation_mode: 'OPEN',
    agile_features: false,
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    code: 'ATLAS',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    timezone: '',
    default_view: 'SCHEDULE',
    lead: null,
    lead_detail: null,
    iteration_label: null,
    effective_iteration_label: 'Sprint',
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: false,
    inherited_public_sharing: false,
    inherited_allow_guests: false,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    // Attachment policy (ADR-0153). Own overrides null = inherit; effective is the
    // resolved value; inherited is what the parent would supply.
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf', 'image/png'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf', 'image/png'],
    is_archived: false,
    archived_at: null,
    archived_by: null,
    recalculated_at: '2026-03-02T00:00:00Z',
    is_sample: false,
    program_detail: null,
    ...overrides,
  };
}

/** Register auth + the project shell. The project detail uses `projectOverride`. */
async function boot(page: Page, projectOverride: Record<string, unknown> = {}): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [makeProject(projectOverride)],
    projectId: PROJECT_ID,
    user: FIXTURE_USER,
    overview: { schedule_health: 'on_track', total_tasks: 1 },
  });
  // useCurrentUserRole reads the first row of this self-scoped array. Admin (300)
  // so the editable Attachments controls render on the settings page.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-self', role: 300, user_id: FIXTURE_USER.id }]),
    }),
  );
}

test.describe('Attachment policy — Project settings', () => {
  test('Admin sees the Attachments section with the inheritable controls', async ({ page }) => {
    await boot(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/attachments`);

    // Gate on the section being rendered before asserting on its controls.
    const section = page.locator('[data-settings-section="attachments"]');
    await expect(section.getByRole('heading', { name: 'Attachments' })).toBeVisible({
      timeout: 10_000,
    });

    // File-attachments toggle is an InheritableToggleField (Inherit/Override pair).
    const enabledGroup = section.getByRole('radiogroup', { name: 'Allow file attachments' });
    await expect(enabledGroup).toBeVisible();
    await expect(enabledGroup.getByText('Inherit (On)')).toBeVisible();

    // Allowed-file-types is the InheritableMultiSelectField — inheriting 2 types.
    const typesGroup = section.getByRole('radiogroup', {
      name: 'Allowed attachment file types',
    });
    await expect(typesGroup).toBeVisible();
    await expect(typesGroup.getByText(/\(2 types\)/)).toBeVisible();
  });

  test('Override reveals the type checklist with an Always-blocked group', async ({ page }) => {
    await boot(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/attachments`);

    const section = page.locator('[data-settings-section="attachments"]');
    await expect(section.getByRole('heading', { name: 'Attachments' })).toBeVisible({
      timeout: 10_000,
    });

    const typesGroup = section.getByRole('radiogroup', {
      name: 'Allowed attachment file types',
    });
    await typesGroup.getByText('Override', { exact: true }).click();

    // The checklist appears, seeded from the inherited set (PDF + PNG checked).
    await expect(section.getByLabel('PDF')).toBeChecked();
    await expect(section.getByLabel('PNG image')).toBeChecked();
    // The permanent security denylist shows as disabled, non-selectable rows.
    // `exact` avoids colliding with the row hint copy that also contains "blocked".
    await expect(section.getByText('Always blocked', { exact: true })).toBeVisible();
    await expect(
      section.getByText('Blocked for security and can\'t be enabled.'),
    ).toBeVisible();
  });
});

test.describe('Attachment policy — disabled drawer state', () => {
  const FIXTURE_TASK = {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Wire HVAC controls',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  };

  const EXISTING_ATTACHMENT = {
    id: 'att-existing-1',
    file: '/media/attachments/spec.pdf',
    file_name: 'spec.pdf',
    file_size: 4096,
    file_mime: 'application/pdf',
    external_url: '',
    external_title: '',
    is_pinned: false,
    uploaded_by: { id: FIXTURE_USER.id, username: 'alice', display_name: 'Alice' },
    deleted_by: null,
    created_at: '2026-05-20T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
  };

  test('disabled policy keeps existing files but shows the disabled note instead of add-controls', async ({
    page,
  }) => {
    // Project resolves to uploads OFF.
    await boot(page, {
      attachments_enabled: false,
      effective_attachments_enabled: false,
      effective_allowed_attachment_types: [],
    });
    await setupApiMocks(page, {
      projects: [
        makeProject({
          attachments_enabled: false,
          effective_attachments_enabled: false,
          effective_allowed_attachment_types: [],
        }),
      ],
      projectId: PROJECT_ID,
      user: FIXTURE_USER,
      tasks: [FIXTURE_TASK],
      overview: { schedule_health: 'on_track', total_tasks: 1 },
    });
    // Re-assert the Admin self-role route (last-registered wins).
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-self', role: 300, user_id: FIXTURE_USER.id }]),
      }),
    );
    // The task's attachment list — one existing file that must still render.
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/attachments/`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [EXISTING_ATTACHMENT],
          }),
        }),
    );

    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await grid.getByText(FIXTURE_TASK.name, { exact: true }).click();

    const drawer = page.getByRole('dialog', { name: new RegExp(FIXTURE_TASK.name) }).first();
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // Open the Files tab, then expand the Attachments section.
    await drawer.getByRole('tab', { name: /^Files/ }).click();
    const header = drawer.getByRole('button', { name: 'Attachments' });
    await expect(header).toBeVisible();
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();

    const region = drawer.getByRole('region', { name: /Attachments/ });
    // Existing file still lists.
    await expect(region.getByText('spec.pdf')).toBeVisible();
    // The disabled note replaces the add-controls.
    await expect(region.getByText(/File attachments are disabled for this project/)).toBeVisible();
    await expect(region.getByText('+ Attach file')).toHaveCount(0);
  });
});
