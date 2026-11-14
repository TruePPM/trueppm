/**
 * Real-browser measurement of the invisible tap pads (`before:` pseudo-element
 * hit areas) from #3509 / #3790 (#4966).
 *
 * A `::before` box is invisible to `boundingBox()` and to every jsdom assertion
 * (web-rule 330/399), and `getComputedStyle(el, '::before')` reports `auto` for
 * an inset box. The only honest measurement is behavioral: walk outward from the
 * control's edge one pixel at a time with `elementFromPoint` and record where the
 * hit stops resolving to the control. That extent IS the effective target.
 *
 *  - WCAG 2.5.8 (AA): every target is at least 24x24 CSS px.
 *  - web-rule 5: pads that claim the 44px touch floor must measure 44.
 *  - A pad must not poke out of the surface that hosts it, and must not swallow a
 *    sibling control's own box (hit-test the sibling's centre).
 */
import { test, expect, type Locator, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

interface Extent {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  box: { x: number; y: number; w: number; h: number };
}

/** Effective hit extent of `target`, scanned from its centre line outward. */
async function measure(target: Locator, max = 40): Promise<Extent> {
  return target.evaluate((el, maxPx) => {
    const r = el.getBoundingClientRect();
    const hits = (x: number, y: number) => {
      const h = document.elementFromPoint(x, y);
      return !!h && (h === el || el.contains(h));
    };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const scan = (dx: number, dy: number, edgeX: number, edgeY: number) => {
      let n = 0;
      while (n < maxPx && hits(edgeX + dx * (n + 1), edgeY + dy * (n + 1))) n++;
      return n;
    };
    const left = scan(-1, 0, r.left, cy);
    const right = scan(1, 0, r.right - 1, cy);
    const top = scan(0, -1, cx, r.top);
    const bottom = scan(0, 1, cx, r.bottom - 1);
    return {
      left,
      right,
      top,
      bottom,
      width: r.width + left + right,
      height: r.height + top + bottom,
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }, max);
}

/** The element at the centre of `other` must still be `other` (no pad swallows it). */
async function centreHitsItself(_page: Page, other: Locator): Promise<string | null> {
  return other.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Off-screen controls (scrolled lanes) cannot be hit-tested.
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const h = document.elementFromPoint(x, y);
    if (!!h && (h === el || el.contains(h))) return null;
    const d = (n: Element | null) =>
      n ? `${n.tagName.toLowerCase()}[${n.getAttribute('aria-label') ?? n.textContent?.slice(0, 20)}]` : 'null';
    return `${d(el)} swallowed by ${d(h)} (${(h as HTMLElement | null)?.className?.toString().slice(0, 80)})`;
  });
}

const PROJECT_ID = 'e2e-touch-pads-0000-0000-0000-000000004966';

const FIELDS = [0, 1, 2, 3, 4].map((i) => ({
  id: `f-${i}`,
  name: `Field ${i}`,
  field_type: 'TEXT',
  required: false,
  order: i,
  show_on_card: true,
  server_version: 1,
  options: [],
}));

function task(id: string, name: string, wbs: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignments: [],
    labels: [],
    custom_fields: {},
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...extra,
  };
}

async function boot(page: Page, tasks: unknown[]) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      { id: PROJECT_ID, name: 'Touch pads', description: '', start_date: '2026-01-01', calendar: 'default' },
    ],
    projectId: PROJECT_ID,
    tasks: tasks as never,
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/fields/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIELDS) }),
  );
}

test.describe('Tap-pad measurement (#4966)', () => {
  test('board "+N more" peek trigger meets 44px and does not swallow neighbors', async ({ page }) => {
    const rich = Object.fromEntries(FIELDS.map((f, i) => [f.id, `value ${i}`]));
    await boot(page, [
      task('t-1', 'Rich Card', '1', { custom_fields: rich }),
      task('t-2', 'Second Card', '2', { custom_fields: rich }),
    ]);
    await page.goto(`/projects/${PROJECT_ID}/board`);
    await expect(page.getByRole('button', { name: /^Rich Card, \d/ })).toBeVisible({ timeout: 10_000 });

    const trigger = page.getByRole('button', { name: /more custom fields?/ }).first();
    await expect(trigger).toBeVisible();
    const m = await measure(trigger);
    // WCAG 2.5.8 floor, then the project's 44px claim (web-rule 5).
    expect(m.width, JSON.stringify(m)).toBeGreaterThanOrEqual(24);
    expect(m.height, JSON.stringify(m)).toBeGreaterThanOrEqual(24);
    expect(m.width, JSON.stringify(m)).toBeGreaterThanOrEqual(44);
    expect(m.height, JSON.stringify(m)).toBeGreaterThanOrEqual(44);

    // Every other control on the board keeps its own centre.
    const others = page.locator('main button:visible');
    const n = await others.count();
    for (let i = 0; i < n; i++) {
      const o = others.nth(i);
      if ((await o.getAttribute('aria-label')) === (await trigger.getAttribute('aria-label'))) continue;
      expect(await centreHitsItself(page, o), `control #${i}`).toBeNull();
    }
  });

  test('compact card on a coarse pointer: every control keeps its own centre and a >=24px target', async ({
    browser,
  }) => {
    // Coarse pointer + compact density is where the signal chip, the dependency
    // and risk chips and the `···` menu sit side by side, each with its own
    // ≥44px pad (#4966 item 3). A hit in an overlap goes to the later-painted
    // pad, so the check is: every control's CENTRE resolves to itself.
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 820, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('trueppm.board.density', 'compact'));
    const busy = Object.fromEntries(FIELDS.map((f, i) => [f.id, `value ${i}`]));
    await boot(page, [
      task('t-1', 'Busy Card', '1', {
        custom_fields: busy,
        predecessor_count: 2,
        is_blocked: true,
        linked_risks_count: 2,
        linked_risks_max_severity: 12,
      }),
    ]);
    await page.goto(`/projects/${PROJECT_ID}/board`);
    await expect(page.getByRole('button', { name: /^Busy Card, \d/ })).toBeVisible({ timeout: 10_000 });

    // Scope: the card's own controls. The toolbar's 22px "Board view" switcher is a
    // different surface and out of this sweep.
    const controls = page
      .getByRole('button', { name: /^Busy Card, \d/ })
      .locator('xpath=ancestor::*[1]')
      .locator('button:visible');
    const n = await controls.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      const label = (await c.getAttribute('aria-label')) ?? (await c.textContent()) ?? `#${i}`;
      // The card's own open button is an inline title; the whole card also opens it.
      if (/^Busy Card, \d/.test(label)) continue;
      expect(await centreHitsItself(page, c), `control ${label}`).toBeNull();
      const m = await measure(c);
      expect(m.width, `${label} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(24);
      expect(m.height, `${label} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(24);
    }
    await ctx.close();
  });

  test('schedule task-ceiling banner dismiss: >=24px target, pad stays inside the banner', async ({ page }) => {
    // Past the 1,000-task ceiling so the banner renders (#3388).
    const many = Array.from({ length: 1005 }, (_, i) => task(`c-${i}`, `Task ${i}`, `${i + 1}`));
    await boot(page, many);
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const banner = page.getByTestId('schedule-task-ceiling-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const dismiss = page.getByTestId('schedule-task-ceiling-banner-dismiss');

    const m = await measure(dismiss);
    expect(m.width, JSON.stringify(m)).toBeGreaterThanOrEqual(24);
    expect(m.height, JSON.stringify(m)).toBeGreaterThanOrEqual(24);

    // The pad must not poke above or below the banner it lives in (#4966 item 2).
    const b = await banner.boundingBox();
    expect(b).not.toBeNull();
    if (!b) return;
    const padTop = m.box.y - m.top;
    const padBottom = m.box.y + m.box.h + m.bottom;
    expect(padTop, JSON.stringify({ m, b })).toBeGreaterThanOrEqual(b.y);
    expect(padBottom, JSON.stringify({ m, b })).toBeLessThanOrEqual(b.y + b.height);
  });
});
