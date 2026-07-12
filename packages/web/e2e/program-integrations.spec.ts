import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Integrations E2E (#1852, closing out the read-only MCP
 * umbrella #603 / ADR-0186).
 *
 * The project-scope MCP token-mint + Connect flow is already covered by
 * `project-integrations.spec.ts` (#1481). This spec covers the PROGRAM-scope
 * equivalent, which had no E2E coverage: the same `ApiTokensManager` mounted with
 * `scope={kind:'program'}` hits `/api/v1/programs/{id}/api-tokens/` instead of the
 * project endpoint. A program-wide `mcp:read` token lets an agent read the whole
 * program's schedule — a distinct surface from a single project.
 *
 * Covers:
 *   - golden path: mint an mcp:read token at program scope → POST carries
 *     scopes:['mcp:read'] against the PROGRAM endpoint → McpConnectPanel reveals
 *     the one-time token + claude_desktop_config.json snippet
 *   - the program-scoped token list renders (heading "Program API tokens")
 *   - empty state when there are no tokens
 */

const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000001852';

const FIXTURE_ME = {
  id: 'user-alice',
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
  code: 'PH2',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: 'user-alice',
  lead_detail: { id: 'user-alice', username: 'alice', email: 'alice@example.com' },
  created_by: 'user-alice',
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 1,
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
};

const TOKEN = {
  id: 'tok-1',
  project: null,
  program: PROGRAM_ID,
  name: 'CI Pipeline',
  token_prefix: 'tppm_a1b',
  status_map: {},
  scopes: ['legacy:full'],
  created_by: null,
  created_at: '2026-05-15T00:00:00Z',
  last_used_at: '2026-05-20T11:00:00Z',
  revoked_at: null,
  is_revoked: false,
};

const pj = (data: unknown) => JSON.stringify(data);
const page1 = (results: unknown[]) =>
  pj({ count: results.length, next: null, previous: null, results });

/**
 * Program consolidated settings (ADR-0146) mounts every section at once, so
 * sibling sections fire their own hooks. The shared 404 catch-all (issue 1513)
 * lets those unmocked endpoints error cleanly instead of crashing the app — the
 * same setup `program-general-settings.spec.ts` relies on. We only mock what the
 * shell + Integrations section actually read.
 */
async function commonRoutes(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1([]) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1([FIXTURE_PROGRAM]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
}

/** Wire the program-scoped webhook + token LIST endpoints with the given rows. */
async function listRoutes(
  page: Page,
  { webhooks, tokens }: { webhooks: unknown[]; tokens: unknown[] },
) {
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/webhooks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1(webhooks) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/api-tokens/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1(tokens) }),
  );
}

test.describe('Program Integrations — MCP token surface', () => {
  test('renders the program-scoped token manager with its list', async ({ page }) => {
    await commonRoutes(page);
    await listRoutes(page, { webhooks: [], tokens: [TOKEN] });

    await page.goto(`/programs/${PROGRAM_ID}/settings/integrations`);

    const section = page.locator('[data-settings-section="integrations"]');
    // Program scope renders "Program API tokens" (project scope says "Inbound API
    // tokens") — assert the program-specific heading to prove the scope wiring.
    // Target the heading role: the same phrase also opens the descriptive <p>.
    await expect(section.getByRole('heading', { name: 'Program API tokens' })).toBeVisible();
    await expect(section.getByText('CI Pipeline')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Create token' })).toBeVisible();
  });

  test('mints a program-scope mcp:read token and shows the connect snippet', async ({ page }) => {
    await commonRoutes(page);
    await listRoutes(page, { webhooks: [], tokens: [] });
    // The create POST echoes the read-only scope so the reveal branches to the MCP
    // connect panel (in production the scope comes from the backend).
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/api-tokens/`, (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({
            ...TOKEN,
            id: 'tok-mcp',
            name: 'Claude Desktop',
            scopes: ['mcp:read'],
            token: 'tppm_PROGRAM_MCP_SECRET',
          }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: page1([]) });
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/integrations`);

    const section = page.locator('[data-settings-section="integrations"]');
    await section.getByRole('button', { name: 'Create token' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create API token' });
    await dialog.getByPlaceholder('e.g. Jira Production').fill('Claude Desktop');
    await dialog.getByRole('radio', { name: /Read-only for AI assistants/i }).check();

    // The POST must hit the PROGRAM endpoint (not a project one) and carry the scope.
    const postReq = page.waitForRequest(
      (req) => req.url().includes(`/programs/${PROGRAM_ID}/api-tokens/`) && req.method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create token' }).click();
    const req = await postReq;
    expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ scopes: ['mcp:read'] });

    // The one-time token is revealed and the paste-ready config snippet renders.
    await expect(page.getByRole('textbox', { name: 'New API token' })).toHaveValue(
      'tppm_PROGRAM_MCP_SECRET',
    );
    const snippet = page.getByLabel('claude_desktop_config.json snippet');
    await expect(snippet).toContainText('"command": "trueppm-mcp"');
    await expect(snippet).toContainText('"TRUEPPM_API_TOKEN": "tppm_PROGRAM_MCP_SECRET"');
    await expect(page.getByRole('button', { name: 'Copy config' })).toBeVisible();
  });

  test('shows the empty state when the program has no tokens', async ({ page }) => {
    await commonRoutes(page);
    await listRoutes(page, { webhooks: [], tokens: [] });

    await page.goto(`/programs/${PROGRAM_ID}/settings/integrations`);

    const section = page.locator('[data-settings-section="integrations"]');
    await expect(section.getByText(/No tokens yet/i)).toBeVisible();
  });
});
