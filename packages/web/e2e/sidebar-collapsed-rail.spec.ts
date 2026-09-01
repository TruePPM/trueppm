/**
 * The collapsed rail is a live 64px navigation landmark — ADR-0979.
 *
 * This file exists because `Sidebar.test.tsx` structurally cannot cover the
 * property that matters. jsdom applies no stylesheet, so `sr-only` and `hidden`
 * are indistinguishable there: both leave the label in the DOM and in the
 * computed accessible name, and mutating one to the other leaves that whole
 * suite green. Only a real browser can tell you whether a collapsed rail of
 * icons is *named*.
 *
 * That is the exact risk ADR-0979 §Risks names — "the existing tests assert the
 * old contract and will keep passing against a wrong implementation" — so the
 * assertions below are deliberately behavioral: width, tab order, and accessible
 * names read out of the real accessibility tree.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-iconrail-0000-0000-0000-000000003279';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Icon Rail Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'iconrail-prog-1', name: 'Icon Rail Program' },
  },
];

const rail = (page: Page) => page.getByRole('complementary', { name: 'Primary navigation' });

async function setupCollapsed(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
  await page.goto(`/projects/${PROJECT_ID}/overview`);
  await expect(rail(page)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(rail(page)).toHaveAttribute('data-collapsed', 'true');
}

test.describe('the collapsed rail is icon-only, not absent (ADR-0979)', () => {
  test('narrows to 64px and stays in the accessibility tree', async ({ page }) => {
    await setupCollapsed(page);

    // Polled, not read once: the rail animates its width over 200ms, so a single
    // `boundingBox()` right after the click samples a mid-transition value (211px
    // when this was written) and fails for a reason that has nothing to do with
    // the contract.
    await expect
      .poll(async () => (await rail(page).boundingBox())?.width)
      .toBe(64);

    // The combination ADR-0979 rejects outright as a WCAG 4.1.2 defect: a
    // visible, clickable 64px nav that assistive tech cannot see.
    await expect(rail(page)).toBeVisible();
    await expect(rail(page)).not.toHaveAttribute('aria-hidden', 'true');
    await expect(rail(page)).not.toHaveAttribute('inert', /.*/);
  });

  test('every icon keeps its accessible name under REAL css', async ({ page }) => {
    await setupCollapsed(page);

    // Names resolve at 64px. Note what this alone does NOT prove: each row also
    // carries a `title` for its tooltip, and `title` is an accname fallback, so
    // these three assertions still pass if the label span is `display:none`
    // (measured — the mutation was run). The mechanism is pinned separately
    // below, because leaning on `title` for the name is a weak contract:
    // screen readers treat it inconsistently and it is the last resort in the
    // accname order.
    await expect(rail(page).getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Schedule', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Timesheet', exact: true })).toBeVisible();

    // ...and the labels are genuinely not *shown*, or this is just a narrow rail
    // with overflowing text rather than an icon rail.
    //
    // Asserted by MEASURING, not with `.not.toBeVisible()`: `sr-only` clips to a
    // 1px box rather than hiding, and Playwright counts a 1px box as visible — so
    // the negative-visibility form fails against a correct implementation.
    const label = rail(page).getByText('Dashboard', { exact: true });
    const { width, display } = await label.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      display: getComputedStyle(el).display,
    }));
    // Clipped to ~1px, so it is not *shown*...
    expect(width).toBeLessThanOrEqual(1);
    // ...but still in the box tree, so it is still the row's accessible name
    // rather than the `title` fallback carrying it alone. This is the assertion
    // that fails if `sr-only` is swapped for `hidden`, and the reason this spec
    // exists at all: jsdom applies no stylesheet, so vitest cannot see it.
    expect(display).not.toBe('none');
  });

  test('band structure survives collapse — traversal is identical, not merely present', async ({
    page,
  }) => {
    // ADR-0979 §5: a screen-reader user's traversal must be the SAME in both
    // states. Compared as sets rather than eyeballed, so a band quietly dropped
    // at 64px fails here rather than in someone's screen reader.
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(rail(page)).toBeVisible({ timeout: 10_000 });

    const groupNames = () =>
      rail(page)
        .getByRole('group')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));

    const expanded = await groupNames();
    expect(expanded).toContain('Plan views');

    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(rail(page)).toHaveAttribute('data-collapsed', 'true');

    expect(await groupNames()).toEqual(expanded);
  });

  test('the rail is keyboard-traversable at 64px', async ({ page }) => {
    await setupCollapsed(page);

    // Focus a rail link directly and walk forward — the point is that the rail's
    // items are tab STOPS, which is the half of the contract that changed: the
    // tab order now grows by the rail's item count where it previously grew by
    // zero.
    const dashboard = rail(page).getByRole('link', { name: 'Dashboard', exact: true });
    await dashboard.focus();
    await expect(dashboard).toBeFocused();

    await page.keyboard.press('Tab');
    const active = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '',
    );
    expect(active).not.toBe('');
    // Focus stayed inside the rail rather than escaping to the canvas.
    expect(await rail(page).locator(':focus').count()).toBe(1);
  });

  test('collapse never reclaims the full canvas (ADR-0979 §3)', async ({ page }) => {
    // The trade this ADR knowingly accepts. Pinned so "just make it 0 again" is a
    // decision someone has to argue for, not a one-character change.
    await setupCollapsed(page);
    const box = await rail(page).boundingBox();
    expect(box?.width).toBeGreaterThan(0);
  });
});
