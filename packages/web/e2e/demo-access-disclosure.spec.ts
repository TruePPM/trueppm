/**
 * The external access gate's email-capture disclosure (ADR-1197 D8 resolution, #3969).
 *
 * A public demo host may sit behind a third-party identity gate — Cloudflare Access on
 * ours — that takes the visitor's email address before any TruePPM code runs. The app
 * cannot detect that, so the deployment declares it (`demo_access_gate` on the
 * pre-auth `/edition/` response) and the login screen confirms it.
 *
 * **The assertion that matters most here is the negative one.** The issue's scope note
 * is that the disclosure must be conditional: a self-hosted instance of this same demo
 * mode, run without a gate, must never carry a false claim that it collects email
 * addresses. Two of the four tests below exist to prove the notice stays *absent* —
 * once for a demo with no gate declared, once for a normal install. A spec that only
 * checked the happy path would pass just as well against a blanket banner, which is
 * precisely the bug this change exists to avoid.
 *
 * `provider` is asserted as operator-supplied text rather than a fixed vendor string,
 * because a demo behind Authelia must not publish a notice naming Cloudflare.
 *
 * The `/edition/` route is registered *after* `setupApiMocks` so it wins — Playwright
 * matches routes in reverse registration order. That keeps the shared fixture
 * untouched; the payload is validated against `docs/api/openapi.json` by the schema
 * guard either way.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-gate-00000000-0000-0000-0000-000000003969';

const DEMO_HINT = { username: 'atlas-visitor@trueppm.com', password: 'trueppm-demo' };

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Access Disclosure Demo',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

type AccessGate = { provider: string; privacy_url: string | null };

/**
 * Serve `/edition/` with an explicit `demo_access_gate`, overriding the fixture's.
 *
 * `null` is the deployment saying "no gate declared" — which is a different fact from
 * "not a demo", and the reason it is passed explicitly rather than omitted.
 */
async function serveEditionWithGate(
  page: import('@playwright/test').Page,
  opts: { demoReadOnly: boolean; accessGate: AccessGate | null },
): Promise<void> {
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        edition: 'community',
        demo_read_only: opts.demoReadOnly,
        demo_login_hint: opts.demoReadOnly ? DEMO_HINT : null,
        demo_access_gate: opts.accessGate,
      }),
    }),
  );
}

const NOTICE = '[data-testid="demo-access-gate-notice"]';

test.describe('Demo access-gate disclosure (ADR-1197 D8, #3969)', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      demoReadOnly: true,
      demoLoginHint: DEMO_HINT,
    });
  });

  test('names the declared gate and links its privacy statement', async ({ page }) => {
    await serveEditionWithGate(page, {
      demoReadOnly: true,
      accessGate: {
        provider: 'Cloudflare Access',
        privacy_url: 'https://example.com/demo-privacy',
      },
    });
    await page.goto('/login');

    const notice = page.locator(NOTICE);
    await expect(notice).toBeVisible();
    // The three facts the disclosure owes a visitor: who took it, what was taken,
    // and that their own install does not do this.
    await expect(notice).toContainText('Cloudflare Access');
    await expect(notice).toContainText('collected your email address');
    await expect(notice).toContainText('no such check unless you add one');

    const link = notice.getByRole('link', { name: /What Cloudflare Access collects/ });
    await expect(link).toHaveAttribute('href', 'https://example.com/demo-privacy');
    // Opening in a new tab without `noopener` would hand the target a window handle
    // back to a page that is mid-authentication.
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('renders the operator-supplied provider, not a hardcoded vendor', async ({ page }) => {
    // The false-claim case in the other direction: a self-hoster behind Authelia must
    // see Authelia, never Cloudflare.
    await serveEditionWithGate(page, {
      demoReadOnly: true,
      accessGate: { provider: 'Authelia', privacy_url: null },
    });
    await page.goto('/login');

    const notice = page.locator(NOTICE);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Authelia');
    await expect(notice).not.toContainText('Cloudflare');
    // No privacy URL declared → no dangling link rather than an empty href.
    await expect(notice.getByRole('link')).toHaveCount(0);
  });

  test('stays silent on a demo with no gate declared', async ({ page }) => {
    // The scope note's case: demo mode is ON, so the credential block renders — but
    // nothing was declared, so the instance must claim no email collection.
    await serveEditionWithGate(page, { demoReadOnly: true, accessGate: null });
    await page.goto('/login');

    await expect(
      page.getByRole('button', { name: 'Fill in the demo email and password' }),
    ).toBeVisible();
    await expect(page.locator(NOTICE)).toHaveCount(0);
  });

  test('stays silent on a normal install', async ({ page }) => {
    await serveEditionWithGate(page, { demoReadOnly: false, accessGate: null });
    await page.goto('/login');

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator(NOTICE)).toHaveCount(0);
  });
});
