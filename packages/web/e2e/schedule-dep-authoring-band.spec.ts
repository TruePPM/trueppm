/**
 * Dependency authoring is its own permission band (#3053, ADR-0773 §7).
 *
 * `ScheduleView` derived ONE `readOnly` flag and gated every mutation on it,
 * while the server gates the two acts on rules that do not contain each other:
 *
 *   task content   `IsProjectPlanAuthor`  role >= MEMBER minus the 200–299 band
 *   dependencies   `IsProjectScheduler`   role >= SCHEDULER
 *
 * So the single boolean was wrong for exactly one band whichever way it went. It
 * resolved as task content, which cost a **Scheduler** canvas drag-to-link that
 * the server answers 200, and offered it to a **Member**, whom the server 403s
 * (`DependencySerializer._authorize_same_project_edge` runs
 * `check_object_permissions` on both endpoint tasks).
 *
 * This spec pins both sides at the surface. It is deliberately driven by BOTH
 * inputs the two gates read — `can_author` on the project and the role on the
 * self-membership row — because a spec that drove only one would keep passing
 * against a re-collapsed flag, which is the exact regression to catch.
 *
 * Gesture mechanics (canvas geometry, the pinned clock, the synthetic pointer
 * sequence) mirror `drag-to-link.spec.ts`; the comments there explain why each
 * piece is shaped the way it is.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, useFullToolbar } from './fixtures';

const PROJECT_ID = 'e2e-band-00000000-0000-0000-0000-000000003053';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

// Pin "today" BEFORE the fixture window so the Schedule's today-framing clamps to
// scrollLeft 0 and the aria-overlay geometry the drag reads stays valid. Without
// this the framing scrolls right and the gesture lands on the wrong coordinate.
const CLOCK = new Date('2026-01-15T12:00:00Z');

const ROLE_MEMBER = 100;
const ROLE_SCHEDULER = 200;

const FIXTURE_TASKS = [
  {
    id: 'bm1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'bm2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

type Rect = { left: number; right: number; top: number; bottom: number };

/** Read the on-screen rect of a bar from its aria-overlay option (rule 67). */
async function barRect(page: import('@playwright/test').Page, name: string): Promise<Rect> {
  const cell = page.locator(
    `[role="listbox"][aria-label="Schedule chart"] [role="option"][aria-label^="${name},"]`,
  );
  await expect(cell).toBeVisible();
  const box = await cell.boundingBox();
  if (!box) throw new Error(`no bounding box for bar "${name}"`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

/** Pointer-down on the source bar's right-edge link dot, drag onto the target, release. */
async function dragLink(
  page: import('@playwright/test').Page,
  source: Rect,
  target: Rect,
): Promise<void> {
  const startX = source.right + 12; // inside the link-dot zone [barRight+8, +16]
  const startY = (source.top + source.bottom) / 2;
  const endX = (target.left + target.right) / 2;
  const endY = (target.top + target.bottom) / 2;
  await page.evaluate(
    ({ startX, startY, endX, endY }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[data-layer="interaction"]',
      );
      if (!canvas) throw new Error('no interaction canvas');
      const opts = (clientX: number, clientY: number, buttons: number): PointerEventInit => ({
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        buttons,
      });
      const orig = canvas.setPointerCapture.bind(canvas);
      canvas.setPointerCapture = (id: number) => {
        try {
          orig(id);
        } catch {
          /* synthetic pointer not active in headless */
        }
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY, 1)));
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(midX, midY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(endX, endY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(endX, endY, 0)));
    },
    { startX, startY, endX, endY },
  );
}

/**
 * Hover the source bar's link dot and report the interaction canvas's cursor.
 *
 * The rest-state affordance for drag-to-link is a canvas painting plus this
 * cursor, and the cursor is the half a test can actually read. `crosshair` is
 * the product promising the gesture will do something; `default` is it saying
 * nothing is on offer. Set synchronously in the pointermove handler, so no poll
 * is needed.
 */
async function linkDotCursor(
  page: import('@playwright/test').Page,
  source: Rect,
): Promise<string> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[data-layer="interaction"]',
      );
      if (!canvas) throw new Error('no interaction canvas');
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          pointerType: 'mouse',
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons: 0,
        }),
      );
      return canvas.style.cursor;
    },
    { x: source.right + 12, y: (source.top + source.bottom) / 2 },
  );
}

test.describe('Schedule — the dependency band is not the task-content band (#3053)', () => {
  /**
   * Model one reader precisely: the project's `can_author` (the task-content
   * gate) and the caller's own membership role (the dependency gate). Both
   * routes are registered AFTER `setupApiMocks`, so they win — the fixture
   * defaults are `can_author: true` and role 300.
   *
   * Returns a live counter of POSTs to `/dependencies/`, which is the observable
   * the whole spec turns on: a withheld gesture writes nothing.
   */
  async function asReader(
    page: import('@playwright/test').Page,
    { canAuthor, role }: { canAuthor: boolean; role: number },
  ): Promise<{ posts: () => number; body: () => Record<string, unknown> | null }> {
    let posts = 0;
    let body: Record<string, unknown> | null = null;

    // Widen past the fit ladder (#3076) before navigating. At Playwright's 1280
    // default the mode pills collapse into a single chip, which breaks BOTH
    // directions of a pill assertion: the allowed reader stops finding the pill,
    // and a `toHaveCount(0)` starts passing because the pill was RATIONED rather
    // than withheld — the one thing a permission spec must tell apart.
    await useFullToolbar(page);
    await page.clock.setFixedTime(CLOCK);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [
        {
          id: PROJECT_ID,
          name: 'Dependency Band Project',
          description: '',
          start_date: '2026-04-01',
          calendar: 'default',
          can_author: canAuthor,
        },
      ],
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
      dependencies: [],
    });

    // `useCurrentUserRole` reads `res.data[0]` off the ?self=true list, which the
    // backend serializes many=True even for one row (#1046) — so both the self
    // and the roster shape are the same list here.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'mem-band', role, role_label: 'Band Reader', user_id: 'e2e-user' },
        ]),
      });
    });

    await page.route('**/api/v1/dependencies/**', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        posts += 1;
        body = req.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'dep-1', ...body, lag: 0 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    });

    return { posts: () => posts, body: () => body };
  }

  test('a Scheduler — refused task content — can still draw a dependency', async ({ page }) => {
    // The regression #3034 introduced and this issue exists to close. The server
    // answers 200 for this band; before the split the client returned early at
    // `commitCreateLink` and the drag wrote nothing.
    const dep = await asReader(page, { canAuthor: false, role: ROLE_SCHEDULER });

    await page.goto(BASE_URL);

    // The task-content apparatus really is absent for this reader — which is
    // what makes the assertion below meaningful rather than a re-test of #3034.
    const badge = page.getByTestId('schedule-view-only');
    await expect(badge).toBeVisible();

    // …and the badge standing in its place does not DENY the capability this
    // reader is about to exercise. "Ask for edit rights to change anything here"
    // is placed by the task-content gate, so it lands on the one role that still
    // holds drag-to-link — and the likeliest reading of it is that the link they
    // just drew will not stick.
    await expect(badge).toContainText('Links only');
    await expect(badge).toContainText(/You can link tasks here/);
    await expect(badge).not.toContainText(/change anything here/);

    const foundation = await barRect(page, 'Foundation');
    const framing = await barRect(page, 'Framing');

    // The affordance is offered, not just the commit accepted.
    expect(await linkDotCursor(page, foundation)).toBe('crosshair');

    await dragLink(page, foundation, framing);

    await expect.poll(() => dep.posts()).toBe(1);
    expect(dep.body()?.predecessor).toBe('bm1');
    expect(dep.body()?.successor).toBe('bm2');
    expect(dep.body()?.dep_type).toBe('FS');
  });

  test('a Member — allowed task content — is not offered the link gesture', async ({ page }) => {
    // The mirror image. A Member authors ROWS and the server 403s their EDGES,
    // so the gesture is withheld at the engine rather than swallowed at commit:
    // no handle, no crosshair, no arm, no write.
    const dep = await asReader(page, { canAuthor: true, role: ROLE_MEMBER });

    await page.goto(BASE_URL);

    // Gate on a "page rendered" signal before asserting absence (#1190) — and
    // this one doubles as the proof the reader IS an author of task content, so
    // a false pass cannot come from the page having refused them outright.
    await expect(page.getByTestId('author-mode-pill')).toBeVisible();

    // The legend's standing instruction goes with the handle. Leaving "drag the
    // ◌ handle…" up while the engine declines to paint it sends this reader
    // hunting for a dot that is genuinely not there.
    await expect(page.getByTestId('schedule-legend')).not.toContainText(
      /handle at a bar’s right edge/,
    );

    const foundation = await barRect(page, 'Foundation');
    const framing = await barRect(page, 'Framing');

    // No promise is made in the first place: the link-dot cursor stays `default`.
    // This is the assertion that distinguishes "withheld" from "swallowed at
    // commit", and it is deterministic — the handler sets the cursor synchronously.
    expect(await linkDotCursor(page, foundation)).not.toBe('crosshair');

    // Wait for the POST that must NOT happen, and require the wait to time out.
    // `expect.poll(...).toBe(0)` would be VACUOUS here: the counter starts at 0,
    // so the very first sample matches and the assertion resolves before the
    // gesture has had any chance to write. This form spends real time instead.
    const noPost = page
      .waitForRequest(
        (r) => r.url().includes('/api/v1/dependencies/') && r.method() === 'POST',
        { timeout: 2000 },
      )
      .then(() => 'posted' as const)
      .catch(() => 'silent' as const);

    await dragLink(page, foundation, framing);

    expect(await noPost).toBe('silent');
    expect(dep.posts()).toBe(0);

    // And no arrow appeared — the refusal is silent, not optimistic.
    await expect(
      page.locator('[role="listbox"][aria-label="Schedule chart"]').getByText(/Depends on:/),
    ).toHaveCount(0);
  });
});
