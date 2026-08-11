/**
 * Schedule drag/keyboard preview overlay (#2819).
 *
 * `PreviewOverlay` had no render site at all until this change: the CPM
 * worker computed per-task preview results on every drag and keyboard nudge,
 * and nothing put them on screen. This spec is the guard against it silently
 * losing its mount again — a pure unit test cannot see that, because the
 * component renders perfectly well in isolation whether or not anyone mounts it.
 *
 * Covers the keyboard-reschedule path (WCAG 2.1.1), which reaches the overlay
 * without a canvas pointer drag:
 * - golden path: entering reschedule mode paints the overlay + the rule-51 key
 *   legend, and the rule-52 origin ghost bar anchors the pre-nudge position;
 * - error/exit state: Escape cancels and the overlay leaves.
 *
 * The pinned-by-actuals disclosure is exercised in
 * `src/features/schedule/PreviewOverlay.test.tsx` — it is reachable only by
 * pointer drag (the keyboard path refuses complete tasks outright), and a
 * canvas-coordinate mouse drag is not a stable e2e gesture.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-prevw-00000000-0000-0000-0000-000000002819';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Preview Overlay Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function task(id: string, name: string, start: string, finish: string, wbs: string) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: start,
    early_finish: finish,
    planned_start: start,
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const FIXTURE_TASKS = [
  task('pv1', 'Foundation', '2026-04-06', '2026-04-10', '1'),
  task('pv2', 'Framing', '2026-04-13', '2026-04-17', '2'),
];

test.describe('Schedule preview overlay (#2819)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    // Gate on the canvas overlay having rendered its rows, not on the toolbar:
    // the overlay mounts inside CanvasScheduleTimeline and only exists once the
    // task read has resolved.
    await expect(page.getByRole('option', { name: /Foundation/ })).toBeVisible();
  });

  test('keyboard reschedule paints the preview overlay and its key legend', async ({ page }) => {
    // Focus, don't click: the ARIA overlay is pointer-events-none by design
    // (rule 27) and the interaction canvas sits under it taking the pointer, so
    // a click never lands on an option. `r` on a focused option is the real
    // keyboard path — it selects the task AND starts the reschedule.
    await page.getByRole('option', { name: /Foundation/ }).focus();
    await page.keyboard.press('r');

    const overlay = page.getByTestId('preview-overlay');
    await expect(overlay).toBeVisible();
    // Rule 51: the full key legend, not the pointer-drag "Esc to cancel".
    await expect(
      overlay.getByText('← → Shift+arrow · d date · Enter confirm · Esc cancel'),
    ).toBeVisible();
    // Issue #1493: the estimate disclosure labels the whole overlay as a
    // client-side prediction the server reconciles on commit.
    await expect(overlay.getByTestId('preview-disclosure')).toHaveText(
      'Preview — server confirms on drop',
    );
  });

  test('renders the rule-52 origin ghost bar below the timeline header', async ({ page }) => {
    // Focus, don't click: the ARIA overlay is pointer-events-none by design
    // (rule 27) and the interaction canvas sits under it taking the pointer, so
    // a click never lands on an option. `r` on a focused option is the real
    // keyboard path — it selects the task AND starts the reschedule.
    await page.getByRole('option', { name: /Foundation/ }).focus();
    await page.keyboard.press('r');

    const overlay = page.getByTestId('preview-overlay');
    await expect(overlay).toBeVisible();

    // The origin bar is the dashed ghost anchoring the pre-nudge position. Its
    // box must sit below the 28px timeline header — the alignment bug that kept
    // this component unmountable against the canvas host.
    const ghost = overlay.locator('div[style*="dashed"]').first();
    await expect(ghost).toBeVisible();
    const box = await ghost.boundingBox();
    const overlayBox = await overlay.boundingBox();
    expect(box).not.toBeNull();
    expect(overlayBox).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(overlayBox!.y + 28);
  });

  test('Escape cancels the reschedule and removes the overlay', async ({ page }) => {
    // Focus, don't click: the ARIA overlay is pointer-events-none by design
    // (rule 27) and the interaction canvas sits under it taking the pointer, so
    // a click never lands on an option. `r` on a focused option is the real
    // keyboard path — it selects the task AND starts the reschedule.
    await page.getByRole('option', { name: /Foundation/ }).focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preview-overlay')).toHaveCount(0);
  });
});
