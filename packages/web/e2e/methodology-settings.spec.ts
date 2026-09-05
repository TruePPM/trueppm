/**
 * Methodology cascade settings (ADR-0107, issues 955 / 1169) — workspace + project.
 *
 * The planning methodology (Agile / Waterfall / Hybrid) cascades
 * workspace → program → project, switched by the workspace's override policy.
 * This spec covers the two new settings surfaces:
 *
 *  - Workspace methodology defaults: pick a default method + an override policy;
 *    the Enterprise-only "Enforce" policy is rendered disabled.
 *  - Project methodology: an Admin overrides the method under the default SUGGEST
 *    policy; under an INHERIT policy the picker locks to the workspace value.
 *
 * All API calls are intercepted via page.route() so no backend is required.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

const PROJECT_ID = 'e2e-meth-00000000-0000-0000-0000-000000000955';

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    name: 'TrueScope Aerospace',
    subdomain: 'truescope',
    timezone: 'UTC',
    fiscal_year_start_month: 1,
    fiscal_year_start_day: 1,
    fiscal_year_start_display: 'January 1',
    work_week: [true, true, true, true, true, false, false],
    default_project_view: 'Overview',
    allow_guests: false,
    public_sharing: false,
    iteration_label: 'Sprint',
    iteration_label_override_policy: 'suggest',
    mc_history_enabled: true,
    mc_history_retention_cap: 100,
    mc_history_attribution_audience: 'admin_owner',
    mc_history_override_policy: 'suggest',
    methodology: 'WATERFALL',
    methodology_override_policy: 'suggest',
    ...overrides,
  };
}

function projectDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Methodology Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: null,
    estimation_mode: 'open',
    agile_features: true,
    iteration_label: 'Sprint',
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    inherited_methodology: 'WATERFALL',
    // The real serializer always emits `program` (null for a standalone project).
    // Omitting it made the standalone case assert on `undefined`, a shape the API
    // never returns (#3293).
    program: null,
    ...overrides,
  };
}

async function baseSetup(page: Page, opts: { workspaceRole?: number | null } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all 401-guard — keeps unmocked requests from tripping the session loop.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);

  // `workspace_role` is a declared field on MeSerializer, so the real /auth/me
  // always emits it (an int for any active user; null only for a deactivated
  // membership). Omitting it here made the mock unrepresentable in production —
  // and since #3314 the workspace methodology page fails closed on anything but
  // a positively-resolved admin, so an absent field renders the whole section
  // read-only and every editable-control assertion below fails. 300 = ADMIN.
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@truescope.io',
        workspace_role: opts.workspaceRole === undefined ? 300 : opts.workspaceRole,
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
}

// ---------------------------------------------------------------------------
// Workspace methodology defaults
// ---------------------------------------------------------------------------

test.describe('Workspace methodology defaults', () => {
  test('golden path — seeds the method + policy and saves a change', async ({ page }) => {
    await baseSetup(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/workspace/', async (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        await r.fulfill(json(workspace({ methodology: 'AGILE', methodology_override_policy: 'inherit' })));
        return;
      }
      await r.fulfill(json(workspace()));
    });

    await page.goto('/settings/methodology');

    // The consolidated settings page (#1248) mounts every section at once, so the
    // iteration-label policy radios (Suggest/Inherit/Enforce) share the page with
    // the methodology ones — scope methodology assertions to the section (rule 195).
    const methodology = page.locator('[data-settings-section="methodology"]');

    // Seeded selection — Waterfall + Suggest.
    await expect(methodology.getByRole('radio', { name: /Waterfall/i, checked: true })).toBeVisible();
    await expect(
      methodology.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeVisible();

    // The Enterprise-only Enforce policy is rendered but disabled.
    await expect(methodology.getByRole('radio', { name: /Enforce/i })).toBeDisabled();

    // Change the default method and policy, then save via the page save bar.
    // The method cards are <button role="radio"> (clickable directly). The policy
    // options are an sr-only <input type="radio"> inside a <label>; the input has
    // zero hit area, so click the visible label text — the label forwards to the
    // input's onChange. (check()/clicking the input is intercepted by the label.)
    await methodology.getByRole('radio', { name: /Agile/i }).click();
    await methodology.getByText('Inherit', { exact: true }).click();
    await expect(methodology.getByRole('radio', { name: /^Inherit/i, checked: true })).toBeVisible();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ methodology: 'AGILE', methodology_override_policy: 'inherit' });
  });

  // #3314 gave this page its own fail-closed role gate because `RequireWorkspaceAdmin`
  // used to admit on a verdict-less /auth/me — `workspace_role: null` was the one
  // non-admin verdict that reached the component through the route.
  //
  // #3330 closed the guard, so that route path no longer reaches the component at
  // all: a null role is now `unknown` and the guard renders its error instead. This
  // test therefore asserts the property it always cared about — a null role never
  // yields an editable methodology form, and never issues a PATCH — at the layer that
  // now decides it. The component's own fail-closed behavior (the #3314 fix, which is
  // NOT being removed: it is defense in depth for any future non-routed mount) stays
  // covered directly by `WorkspaceMethodologyPage.test.tsx`, parameterised over both
  // `null` and `false`.
  test('fails closed — a null workspace_role never reaches an editable methodology form', async ({
    page,
  }) => {
    await baseSetup(page, { workspaceRole: null });

    let patched = false;
    await page.route('**/api/v1/workspace/', async (r) => {
      if (r.request().method() === 'PATCH') {
        patched = true;
      }
      await r.fulfill(json(workspace()));
    });

    await page.goto('/settings/methodology');

    // The guard's no-verdict state, not the settings page and not a redirect.
    await expect(
      page.getByRole('alert').filter({ hasText: "Couldn't confirm your workspace role." }),
    ).toBeVisible();

    // The section never mounts, so there is nothing editable and no save bar.
    await expect(page.locator('[data-settings-section="methodology"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Save changes/i })).toHaveCount(0);
    expect(patched).toBe(false);
  });

  // #3298 — the page destructured only `data`/`isLoading`, so a failed GET left
  // the section pulsing forever with no error and no way out (rule 246). Scoped to
  // the section, since the consolidated page mounts every one of them and siblings
  // reading the same GET render their own "Retry".
  test('a failed workspace GET renders an error + Retry, not a perpetual skeleton', async ({
    page,
  }) => {
    await baseSetup(page);

    let attempts = 0;
    await page.route('**/api/v1/workspace/', async (r) => {
      attempts += 1;
      // The query client retries once (`failureCount < 1`), so the initial load is
      // two attempts — fail both, then serve the request the Retry button fires.
      if (attempts <= 2) {
        await r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: pj({ detail: 'boom' }),
        });
        return;
      }
      await r.fulfill(json(workspace()));
    });

    await page.goto('/settings/methodology');

    const methodology = page.locator('[data-settings-section="methodology"]');
    await expect(methodology.getByText("Couldn't load workspace settings.")).toBeVisible();
    // The heading survives the error branch — <SettingsSection aria-labelledby>
    // points at it, so dropping it would dangle that reference.
    await expect(methodology.getByRole('heading', { name: 'Methodology defaults' })).toBeVisible();

    // Retry re-runs just this request and the section recovers in place.
    await methodology.getByRole('button', { name: 'Retry' }).click();
    await expect(
      methodology.getByRole('radio', { name: /Waterfall/i, checked: true }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Project methodology
// ---------------------------------------------------------------------------

test.describe('Project methodology', () => {
  async function projectRoutes(
    page: Page,
    opts: { ws?: Record<string, unknown>; project?: Record<string, unknown>; role?: number } = {},
  ) {
    const role = opts.role ?? 300; // Admin
    await page.route('**/api/v1/workspace/', (r) => r.fulfill(json(workspace(opts.ws))));
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
      r.fulfill(json([{ id: 'mem-1', role }])),
    );
    await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
    // #3313 — the methodology page now gates its skeleton on the sprint count and
    // treats a FAILED sprints read as "cannot rule out sprints" (so the flip
    // warning arms). Under the 404 catch-all an unmocked endpoint is a failure,
    // which would arm the consent dialog in every flip test below. Default to an
    // explicit empty list so these specs describe a sprint-free project. Tests
    // that need sprints re-route this after calling projectRoutes (last wins).
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
    );
  }

  test('golden path — an Admin overrides the method under SUGGEST', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        await r.fulfill(json(projectDetail({ methodology: 'WATERFALL', effective_methodology: 'WATERFALL' })));
        return;
      }
      await r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    // #2969 folded Methodology into the consolidated 'How this team works'
    // section — the project rail has one row for the three, so the section
    // scope moved with it. The WORKSPACE methodology page is untouched.
    const methodology = page.locator('[data-settings-section="how-this-team-works"]');
    // Seeded from the project's own method, with the inherited default surfaced.
    await expect(methodology.getByRole('radio', { name: /Agile/i, checked: true })).toBeVisible();
    await expect(methodology.getByText(/Inherited from the workspace default/i)).toBeVisible();

    // Override to Waterfall and save.
    await methodology.getByRole('radio', { name: /Waterfall/i }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ methodology: 'WATERFALL' });
  });

  // #3293 — `inherited_methodology` resolves program → workspace, but the banner
  // hard-coded "workspace default". The golden path above covers the standalone
  // case; this is the same project inside a program.
  test('the inheritance banner names the program when the project has one (#3293)', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
      r.fulfill(json(projectDetail({ program: 'prog-1' }))),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const methodology = page.locator('[data-settings-section="how-this-team-works"]');
    // Gate on the section's own rendered content before asserting the copy.
    await expect(methodology.getByRole('radio', { name: /Agile/i, checked: true })).toBeVisible();
    await expect(methodology.getByText(/Inherited from the program default/i)).toBeVisible();
    await expect(methodology.getByText(/Inherited from the workspace default/i)).toHaveCount(0);
  });

  test('surfaces estimate governance and saves only estimation_mode (#2018)', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        await r.fulfill(json(projectDetail({ estimation_mode: 'pm_only' })));
        return;
      }
      await r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    // #2969 folded Methodology into the consolidated 'How this team works'
    // section — the project rail has one row for the three, so the section
    // scope moved with it. The WORKSPACE methodology page is untouched.
    const methodology = page.locator('[data-settings-section="how-this-team-works"]');
    const estimation = methodology.getByRole('combobox', { name: 'Estimate governance' });
    await expect(estimation).toHaveValue('open');

    await estimation.selectOption('pm_only');
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    // Methodology was untouched → only estimation_mode is sent.
    expect(patchBody).toMatchObject({ estimation_mode: 'pm_only' });
    expect(patchBody).not.toHaveProperty('methodology');
  });

  test('keeps estimate governance editable under an INHERIT methodology lock (#2018)', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page, { ws: { methodology_override_policy: 'inherit' } });

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        await r.fulfill(json(projectDetail({ estimation_mode: 'pm_only' })));
        return;
      }
      await r.fulfill(json(projectDetail({ methodology: 'AGILE', effective_methodology: 'WATERFALL' })));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    // #2969 folded Methodology into the consolidated 'How this team works'
    // section — the project rail has one row for the three, so the section
    // scope moved with it. The WORKSPACE methodology page is untouched.
    const methodology = page.locator('[data-settings-section="how-this-team-works"]');

    // Methodology is locked read-only by workspace policy (ADR-0133): no disabled
    // radios — effective value (Waterfall) + provenance instead. Scoped to the
    // methodology picker: the sibling estimation-scale field carries its own
    // inherit/override radios (independent of the lock, #2027).
    const methodPicker = methodology.locator('section[aria-labelledby="method-heading"]');
    await expect(methodPicker.getByRole('radio')).toHaveCount(0);
    await expect(
      methodology.getByLabel('Methodology: Waterfall, locked by workspace policy. View only.'),
    ).toBeVisible();
    // …but estimate governance is independent — still editable, saves on its own.
    const estimation = methodology.getByRole('combobox', { name: 'Estimate governance' });
    await expect(estimation).toBeEnabled();
    await estimation.selectOption('pm_only');
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ estimation_mode: 'pm_only' });
    expect(patchBody).not.toHaveProperty('methodology');
  });

  test('locked state — INHERIT policy disables the picker and shows the workspace value', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page, { ws: { methodology_override_policy: 'inherit' } });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
      r.fulfill(json(projectDetail({ methodology: 'AGILE', effective_methodology: 'WATERFALL' }))),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    // #2969 folded Methodology into the consolidated 'How this team works'
    // section — the project rail has one row for the three, so the section
    // scope moved with it. The WORKSPACE methodology page is untouched.
    const methodology = page.locator('[data-settings-section="how-this-team-works"]');
    // The lock context message is shown.
    await expect(
      methodology.getByText(/requires every project to use its default methodology/i),
    ).toBeVisible();

    // The locked picker shows the workspace-resolved value (Waterfall) read-only —
    // no disabled radios (ADR-0133): effective value + provenance instead. Scoped to
    // the methodology picker: the sibling estimation-scale field carries its own
    // inherit/override radios (independent of the lock, #2027).
    const methodPicker = methodology.locator('section[aria-labelledby="method-heading"]');
    await expect(methodPicker.getByRole('radio')).toHaveCount(0);
    await expect(
      methodology.getByLabel('Methodology: Waterfall, locked by workspace policy. View only.'),
    ).toBeVisible();
  });

  // #3298 — same defect one scope down. Scoped to the block rather than the
  // section: Methodology shares "How this team works" with Workflow and
  // Guardrails, which read the same project GET and surface their own Retry.
  test('a failed project GET renders an error + Retry, not a perpetual skeleton', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page);

    let attempts = 0;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (r) => {
      attempts += 1;
      // Two attempts on the initial load (the query client retries once) — fail
      // both, then serve the request the Retry button fires.
      if (attempts <= 2) {
        await r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: pj({ detail: 'boom' }),
        });
        return;
      }
      await r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const block = page.locator('[data-settings-anchor="methodology"]');
    await expect(block.getByText("Couldn't load this project's methodology.")).toBeVisible();
    await expect(block.getByRole('heading', { name: 'Methodology', exact: true })).toBeVisible();

    await block.getByRole('button', { name: 'Retry' }).click();
    await expect(block.getByRole('radio', { name: /Agile/i, checked: true })).toBeVisible();
  });

  // #3298 — the dialog has always rendered a `Switching…` state from its `pending`
  // prop, but the call site passed `pending={false}` and unmounted the dialog in
  // `onConfirm`, so the state was unreachable and a slow PATCH gave no feedback.
  test('the flip warning dialog shows its pending state while the PATCH is in flight', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page);

    // Two committed sprints arm the consent gate (#2619).
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill(
        json({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 'sp-1', name: 'Sprint 1', state: 'CLOSED' },
            { id: 'sp-2', name: 'Sprint 2', state: 'ACTIVE' },
          ],
        }),
      ),
    );

    // Hold the PATCH open so the in-flight window is observable rather than a race.
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (r) => {
      if (r.request().method() === 'PATCH') {
        await patchGate;
        await r.fulfill(
          json(projectDetail({ methodology: 'WATERFALL', effective_methodology: 'WATERFALL' })),
        );
        return;
      }
      await r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const block = page.locator('[data-settings-anchor="methodology"]');
    await block.getByRole('radio', { name: /Waterfall/i }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Switch to Waterfall?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('2 sprints already committed')).toBeVisible();

    const confirm = dialog.getByRole('button', { name: 'Switch to Waterfall' });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Still mounted, now showing progress, with both controls disabled so the flip
    // cannot be re-fired or abandoned mid-write.
    await expect(dialog.getByRole('button', { name: 'Switching…' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Disabling the button the user just activated blurs it, so focus must be
    // re-seated inside the dialog — otherwise it lands on <body>, the pending
    // state is announced to nobody, and the modal is up with focus outside it.
    // `useFocusTrap` handles this only when it is given a `focusKey`.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const d = document.querySelector('[role="alertdialog"]');
          return d ? d.contains(document.activeElement) : null;
        }),
      )
      .toBe(true);

    releasePatch();
    await expect(dialog).toBeHidden();
  });

  // #3313 — two defects in the same predicate, both reproducible only against a
  // real render: the save was live before the sprint count was known (so a fast
  // save skipped the consent gate on timing alone), and the count the dialog
  // printed was the length of page 1 rather than the project's total.
  test('the save waits for the sprint count, and the dialog names the server total', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page);

    // Hold the sprints read open so the pre-settle window is observable rather
    // than a race — this is exactly the window a fast PM saved in.
    let releaseSprints!: () => void;
    const sprintGate = new Promise<void>((resolve) => {
      releaseSprints = resolve;
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, async (r) => {
      await sprintGate;
      // 37 sprints across the whole list; page 1 carries two of them.
      await r.fulfill(
        json({
          count: 37,
          next: `http://localhost/api/v1/projects/${PROJECT_ID}/sprints/?page=2`,
          previous: null,
          results: [
            { id: 'sp-1', name: 'Sprint 1', state: 'COMPLETED' },
            { id: 'sp-2', name: 'Sprint 2', state: 'ACTIVE' },
          ],
        }),
      );
    });

    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => r.fulfill(json(projectDetail())));

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    // The block itself renders — the sprints read gates the SAVE, not the page,
    // so the picker is reachable and the section heading (which the settings
    // jump strip focuses) stays in the DOM throughout.
    const block = page.locator('[data-settings-anchor="methodology"]');
    await expect(block.getByRole('heading', { name: 'Methodology', exact: true })).toBeVisible();

    const waterfall = block.getByRole('radio', { name: /Waterfall/i });
    await waterfall.click();
    // The flip is chosen but not yet committable: with the count unknown, a save
    // here would evaluate the orphan-sprints trigger against 0 and skip the
    // consent dialog. The section is not dirty, so the save bar never arms.
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeHidden();

    releaseSprints();

    // The pending selection survives the query landing, and the bar arms.
    await expect(waterfall).toBeChecked();
    await page.getByRole('button', { name: /Save changes/i }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Switch to Waterfall?' });
    await expect(dialog).toBeVisible();
    // 37, not 2 — the number the user reads has to be the project's total.
    await expect(dialog.getByText('37 sprints already committed')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  // #3313 — a failed sprints read must not read as "no sprints". The count is 0
  // either way, so without an explicit error branch the one warning that exists
  // for this flip is silently suppressed by an unrelated outage.
  test('a failed sprints read still warns, with the count declared unknown', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page);

    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: pj({ detail: 'boom' }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => r.fulfill(json(projectDetail())));

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const block = page.locator('[data-settings-anchor="methodology"]');
    await block.getByRole('radio', { name: /Waterfall/i }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Switch to Waterfall?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('may have sprints already committed')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});
