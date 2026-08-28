import type { Page } from '@playwright/test';

/**
 * Turn on Schedule Display options that ship **off** (#2955).
 *
 * `structureButtons` — the Phase / Group / Ungroup toolbar buttons — defaults to false
 * because `⌥⌘G` and `⇥` already make phases and the #2959 persona panel took the leaner
 * reading. A spec that clicks those buttons therefore has to opt in, exactly as a user
 * does through the Display menu's Outline section.
 *
 * Written through `addInitScript` rather than by driving the menu: the preference is
 * per-user, per-project `localStorage`, so seeding it is the honest reproduction of
 * "this planner turned them on last week" — and a spec that opened the menu first would
 * be testing the menu on its way to testing something else. `schedule-display-menu.spec`
 * owns the toggle itself.
 *
 * Must run before `page.goto` — `useScheduleDisplayOptions` hydrates once on mount.
 */
export async function setupScheduleDisplayOptions(
  page: Page,
  projectId: string,
  options: Partial<{
    structureButtons: boolean;
    coach: boolean;
    comfortableRows: boolean;
    /** #3079 — whether a plain Enter also inserts a row after committing. */
    enterCreatesRow: boolean;
    // The #3076 toolbar pins live in this same stored object. A spec that needs
    // a specific control to be a BUTTON can unpin the ones it does not assert
    // on, which buys the fit ladder room and stops the control it does care
    // about riding on a marginal rung.
    pinMilestone: boolean;
    pinExportPdf: boolean;
    pinCounts: boolean;
    pinToday: boolean;
  }>,
  userId = 'e2e-user',
): Promise<void> {
  await page.addInitScript(
    ([key, value]: [string, string]) => window.localStorage.setItem(key, value),
    [
      `trueppm.schedule.displayOptions.${userId}.${projectId}`,
      JSON.stringify(options),
    ] as [string, string],
  );
}
