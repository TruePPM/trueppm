import { test, expect } from '@playwright/test';

/**
 * Brand v2 (navy/sage) palette guard — issue #919, ADR-0103.
 *
 * The navy/sage rebrand shipped without dedicated e2e coverage (the spec was
 * authored locally during `feat/brand-rebrand-navy-sage` but never committed).
 * This locks the brand tokens so a stray Tailwind class or token edit can't
 * silently revert a surface to the legacy blue/green.
 *
 * Assertions run on the unauthenticated `/login` surface, which renders the
 * canonical brand lockup (duotone `LogoMark` + two-color wordmark), the navy
 * body ink, and the sage primary CTA. Staying on `/login` keeps the spec
 * independent of the auth/mock fixture and stable in CI.
 *
 * Values are the LIGHT-mode resolutions of the design-system tokens
 * (tailwind.config.ts / globals.css). `colorScheme: 'light'` is pinned so the
 * `theme: 'auto'` default can't flip these to the dark reversals.
 *   - navy-700 / --neutral-text-primary  #1B2A4A  rgb(27, 42, 74)   (rule 147)
 *   - sage-500 (wordmark "PPM", fills)    #4FA884  rgb(79, 168, 132) (rule 143)
 *   - --brand-primary (CTA = sage-700)    #316F57  rgb(49, 111, 87)  (rule 143, AA foreground 5.93:1)
 */

const NAVY_INK = 'rgb(27, 42, 74)'; // #1B2A4A — navy-700 / --neutral-text-primary
const SAGE_500 = 'rgb(79, 168, 132)'; // #4FA884 — sage-500 (wordmark accent / fills)
const SAGE_700 = 'rgb(49, 111, 87)'; // #316F57 — --brand-primary (light), AA foreground

test.use({ colorScheme: 'light' });

test.describe('brand v2 navy/sage palette (login)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('wordmark is two-color: "True" navy ink + "PPM" sage', async ({ page }) => {
    // The lockup carries the accessible name; the visible text is split across
    // spans, so assert color on each span rather than the full string (rule 142).
    const lockup = page.getByLabel('TruePPM');
    await expect(lockup.getByText('True', { exact: true })).toHaveCSS('color', NAVY_INK);
    await expect(lockup.getByText('PPM', { exact: true })).toHaveCSS('color', SAGE_500);
  });

  test('LogoMark renders navy nodes + sage critical-path arrow', async ({ page }) => {
    const lockup = page.getByLabel('TruePPM');
    // sage arrowhead holds in both modes; navy nodes reverse on dark (rule 142).
    await expect(lockup.locator('polygon')).toHaveCSS('fill', SAGE_500);
    await expect(lockup.locator('circle').first()).toHaveCSS('fill', NAVY_INK);
  });

  test('heading uses navy ink, not a legacy near-black', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCSS('color', NAVY_INK);
  });

  test('primary CTA uses sage (brand-primary), not legacy blue/green', async ({ page }) => {
    // bg-brand-primary resolves to the AA-safe sage-700 foreground weight in
    // light mode; the disabled `opacity-50` does not alter the background-color
    // channel, so this holds whether or not the form is fillable.
    const cta = page.getByRole('button', { name: 'Sign in' });
    await expect(cta).toHaveCSS('background-color', SAGE_700);
  });
});
