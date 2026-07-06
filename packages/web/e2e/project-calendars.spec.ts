import { test, expect, type Page, type Route } from '@playwright/test';
import { setupAuth } from './fixtures/auth';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E coverage for the Working-calendars project-settings panel (#906, ADR-0251).
 *
 *  - Golden path: open the panel, add a holiday overlay via the picker, and see
 *    both the applied stack and the "working days lost" summary update.
 *  - Read-only: a Viewer sees the panel with the view-only note and no add/remove
 *    controls.
 *  - Error: a failed applied-calendars load shows the branded error surface.
 *
 * Per CLAUDE.md: the catch-all 404 net does NOT cover this data page — every
 * endpoint the panel reads (library list, applied object, preview object) is
 * mocked with its real response shape, catch-all is registered FIRST and the
 * specific calendar routes LAST (Playwright matches in reverse registration
 * order), and interactions gate on a "panel rendered" signal.
 */

const PROJECT_ID = 'e2e-cal-00000000-0000-0000-0000-000000000001';

const BASE_CAL = {
  id: 'base-cal',
  server_version: 1,
  name: 'Project calendar',
  working_days: 31, // Mon–Fri
  hours_per_day: 8,
  timezone: 'UTC',
  exceptions: [],
};

const LIB_UK = {
  id: 'lib-uk',
  server_version: 1,
  name: 'UK Bank Holidays 2026',
  working_days: 31,
  hours_per_day: 8,
  timezone: 'UTC',
  exceptions: [{ id: 'x-uk', exc_start: '2026-08-31', exc_end: '2026-08-31', description: 'Summer bank holiday' }],
};

const LIBRARY = [LIB_UK];

const CAL_LOOKUP: Record<string, typeof BASE_CAL> = {
  'base-cal': BASE_CAL,
  'lib-uk': LIB_UK,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

interface AppliedOverlay {
  layer_id: string;
  role: 'holidays' | 'workspace';
  sort_order: number;
  calendar: typeof BASE_CAL;
}

/** Build the GET /calendars/ object shape from the current overlay state. */
function appliedResponse(overlays: AppliedOverlay[]) {
  const baseEntry = { layer_id: null, role: 'project', sort_order: 0, calendar: BASE_CAL };
  return {
    base: BASE_CAL,
    overlays,
    applied: [baseEntry, ...overlays],
  };
}

/** Synthesize a preview for the requested window; weekends are non-working,
 *  and — once an overlay is applied — the first working day becomes a holiday
 *  so the "working days lost" summary flips from 0 to 1. */
function previewResponse(start: string, end: string, hasOverlay: boolean) {
  const days: { date: string; working: boolean; sources: { role: string; calendar_id: string; name: string }[] }[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  let flipped = false;
  while (cur <= last) {
    const iso = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (weekend) {
      days.push({ date: iso, working: false, sources: [{ role: 'project', calendar_id: 'base-cal', name: 'Project calendar' }] });
    } else if (hasOverlay && !flipped) {
      flipped = true;
      days.push({ date: iso, working: false, sources: [{ role: 'holidays', calendar_id: 'lib-uk', name: 'UK Bank Holidays 2026' }] });
    } else {
      days.push({ date: iso, working: true, sources: [] });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { start, end, days };
}

interface SetupOptions {
  role?: number; // self membership role ordinal; default Admin (300) = Scheduler+
  appliedFails?: boolean; // GET /calendars/ returns 500
  previewFails?: boolean; // GET /calendars/preview/ returns 500
}

async function setup(page: Page, opts: SetupOptions = {}) {
  const { role = 300, appliedFails = false, previewFails = false } = opts;

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [{ id: PROJECT_ID, name: 'Artemis IV Lift', description: '', start_date: '2026-01-01', calendar: 'default' }],
    projectId: PROJECT_ID,
    members: [{ id: 'mem-self', role }],
  });

  // Self-membership role drives the read-only gate.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('self') === 'true') {
      return route.fulfill(json([{ id: 'mem-self', role }]));
    }
    return route.fulfill(json([{ id: 'mem-self', role }]));
  });

  // Stateful overlay set — starts base-only so the empty nudge shows.
  let overlays: AppliedOverlay[] = [];

  // Library list (override the fixture's empty default).
  await page.route('**/api/v1/calendars/', (route: Route) => route.fulfill(json(LIBRARY)));

  // Preview — keyed off whether an overlay is applied. Registered before the
  // applied route so the more specific `/preview/` suffix still resolves here.
  await page.route('**/api/v1/projects/*/calendars/preview/**', (route: Route) => {
    if (previewFails) {
      return route.fulfill(json({ detail: 'preview service unavailable' }, 500));
    }
    const url = new URL(route.request().url());
    const start = url.searchParams.get('start') ?? '2026-11-01';
    const end = url.searchParams.get('end') ?? '2027-01-31';
    return route.fulfill(json(previewResponse(start, end, overlays.length > 0)));
  });

  // Applied stack — GET returns current state; PUT atomically replaces overlays.
  await page.route('**/api/v1/projects/*/calendars/', (route: Route) => {
    const req = route.request();
    if (appliedFails && req.method() === 'GET') {
      return route.fulfill(json({ detail: 'scheduling service unavailable' }, 500));
    }
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}') as {
        overlays: { calendar_id: string; role: 'holidays' | 'workspace' }[];
      };
      overlays = body.overlays.map((o, i) => ({
        layer_id: `L${i + 1}`,
        role: o.role,
        sort_order: i + 1,
        calendar: CAL_LOOKUP[o.calendar_id] ?? BASE_CAL,
      }));
      return route.fulfill(json(appliedResponse(overlays)));
    }
    return route.fulfill(json(appliedResponse(overlays)));
  });

  await page.goto(`/projects/${PROJECT_ID}/settings/calendars`);
}

/** The calendars section region, gated on its "panel rendered" signal. */
async function calendarsPanel(page: Page) {
  const panel = page.locator('section[data-settings-section="calendars"]');
  await expect(panel.getByRole('heading', { name: 'Working calendars' })).toBeVisible({ timeout: 10_000 });
  // "Effective working time" only renders after the preview read resolves.
  await expect(panel.getByText('Effective working time')).toBeVisible({ timeout: 10_000 });
  return panel;
}

test('golden path: adding a holiday overlay updates the stack and the summary', async ({ page }) => {
  await setup(page);
  const panel = await calendarsPanel(page);

  // Empty nudge is present (base only), summary shows zero lost days.
  await expect(panel.getByRole('heading', { name: 'No holiday calendars applied' })).toBeVisible();
  await expect(panel.getByText(/loses\s+0\s+working days/i)).toBeVisible();

  // Open the picker and add the UK holidays calendar.
  await panel.getByRole('button', { name: 'Add calendar' }).click();
  const picker = page.getByRole('dialog', { name: 'Add calendars to this project' });
  await expect(picker).toBeVisible();
  await picker.getByRole('option', { name: /UK Bank Holidays 2026/ }).click();
  await picker.getByRole('button', { name: /Add 1 calendar/ }).click();

  // The overlay now appears in the applied stack…
  await expect(panel.getByText('UK Bank Holidays 2026')).toBeVisible();
  // …and the summary reflects the newly-blocked working day.
  await expect(panel.getByText(/loses\s+1\s+working day\b/i)).toBeVisible();
});

test('read-only: a Viewer sees the view-only note and no edit controls', async ({ page }) => {
  await setup(page, { role: 0 }); // Viewer
  const panel = await calendarsPanel(page);

  await expect(panel.getByText(/You have view-only access/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add calendar' })).toHaveCount(0);
});

test('error: a failed load shows the branded error surface, not a blank panel', async ({ page }) => {
  await setup(page, { appliedFails: true });
  const panel = page.locator('section[data-settings-section="calendars"]');
  await expect(panel.getByRole('heading', { name: "Couldn't load working calendars" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('preview error: a failed preview shows an inline retry, not a blank pane', async ({ page }) => {
  // Applied stack loads; only the preview read fails — the panel stays usable
  // and the preview pane surfaces its own error + Retry.
  await setup(page, { previewFails: true });
  const panel = await calendarsPanel(page);

  const previewAlert = panel.getByRole('alert');
  await expect(previewAlert).toBeVisible();
  await expect(previewAlert).toContainText("Couldn't load the working-time preview");
  await expect(previewAlert.getByRole('button', { name: 'Retry' })).toBeVisible();
  // The applied stack is unaffected — the base row still renders.
  await expect(panel.getByText('Project calendar')).toBeVisible();
});
