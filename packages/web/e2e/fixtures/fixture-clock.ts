import type { Page } from '@playwright/test';

/**
 * Pin "today" inside the Oct-Nov 2026 range the schedule fixtures use.
 *
 * The fixture dates are absolute but ScheduleView's one-shot initial framing
 * reads the wall clock; once today is far enough past the bars, coverage drops
 * below MIN_FRAMED_BAR_COVERAGE and framing falls back to fit-to-project, which
 * changes pxPerDay and breaks zoom-stepper and scroll-coordinate assertions
 * (#5119). setFixedTime freezes Date only; timers (e.g. the 250 ms zoom
 * announce debounce) still run. Call before the first navigation.
 */
export async function pinFixtureClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'));
}
