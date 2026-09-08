import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type StatusSummaryFixture } from './fixtures';

/**
 * The shell health chip prints the SERVER's health band (#3501).
 *
 * `views.py::compute_health_band` puts the PM's manual `Project.health` report
 * ahead of the at-risk / critical task counts, and `status-summary` now carries
 * the result as `health_band`. Before that field existed the chip could only see
 * the two counts, so it re-derived a band that could not contain the override:
 * a project a PM had reported Critical on a clean plan read "On track" in the
 * top bar while its own Overview said Critical, and the inverse happened when a
 * reported "On track" sat over a real critical task.
 *
 * Both cases below therefore set `health_band` AGAINST the counts on the same
 * payload. That disagreement is the whole test: a chip that went back to
 * deriving from `critical_count` / `at_risk_count` would print the opposite word
 * in each one, and every assertion here would fail.
 */

const PROJECT_ID = 'e2e-health-band-0000-0000-0000-000000003501';

/** The top bar's chip, present on every in-project route. */
function shellChip(page: Page) {
  return page.getByTestId('health-cluster');
}

/**
 * The Overview header's "Reported: X" chip — the PM's manual report, rendered
 * only when it is not AUTO. This is the surface the top bar used to contradict,
 * so the spec asserts the two on the same screen rather than trusting either
 * alone.
 */
function reportedChip(page: Page, word: string) {
  return page.getByLabel(`Reported project health: ${word}`);
}

interface Scenario {
  /** The manual `Project.health` value the PM set. `AUTO` = no report filed. */
  health: 'CRITICAL' | 'ON_TRACK' | 'AUTO';
  /** The band the server computes from that override — what the chip prints. */
  statusSummary: Partial<StatusSummaryFixture>;
}

async function setup(page: Page, scenario: Scenario) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projectId: PROJECT_ID,
    projects: [
      {
        id: PROJECT_ID,
        name: 'Health Band Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        // The manual override the Overview header reads directly. The shell chip
        // never sees this field — it reads the band the server derived from it.
        health: scenario.health,
        methodology: 'WATERFALL',
      },
    ],
    // `schedule_health` is the SPI-proxy KPI badge, a different signal from the
    // manual report (ADR-0126). Pinned to `unknown` so its own word cannot be
    // mistaken for the reported chip's in any assertion below.
    overview: { schedule_health: 'unknown', total_tasks: 4, critical_task_count: 1 },
    statusSummary: scenario.statusSummary,
  });
}

test.describe('Shell health chip reads the server band (#3501)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('a manually Critical project on a clean plan reads Critical in the top bar', async ({
    page,
  }) => {
    await setup(page, {
      health: 'CRITICAL',
      // Zero at-risk and zero critical tasks: the counts branch alone would say
      // "On track". `health_band` carries the PM's report.
      statusSummary: {
        task_count: 6,
        health_band: 'critical',
        at_risk_count: 0,
        critical_count: 0,
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Same screen, same project: the top bar and the Overview header agree.
    const chip = shellChip(page);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Critical');
    await expect(chip).not.toContainText('On track');
    await expect(reportedChip(page, 'Critical')).toBeVisible();

    // …and it stays Critical on the routes where the header is not on screen —
    // the top bar is the ONLY health reading a PM gets on Schedule (#3501).
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(shellChip(page)).toContainText('Critical');
    await expect(shellChip(page)).not.toContainText('On track');
  });

  test('a manually On-track project over a real critical task reads On track', async ({ page }) => {
    await setup(page, {
      health: 'ON_TRACK',
      // Two genuinely critical tasks and four at-risk ones: the counts branch
      // alone would say "Critical" over the PM's own report.
      statusSummary: {
        task_count: 12,
        health_band: 'on_track',
        at_risk_count: 4,
        critical_count: 2,
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const chip = shellChip(page);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('On track');
    await expect(chip).not.toContainText('Critical');
    await expect(reportedChip(page, 'On track')).toBeVisible();

    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(shellChip(page)).toContainText('On track');
    await expect(shellChip(page)).not.toContainText('Critical');
  });

  test('the chip still reads the band on an AUTO project with no report', async ({ page }) => {
    // The control: with `health = AUTO` the server falls through to the counts,
    // so band and counts agree and the Overview shows no reported chip at all.
    // Without this case the two above could both pass on a chip that had simply
    // inverted its own derivation.
    await setup(page, {
      health: 'AUTO',
      statusSummary: {
        task_count: 9,
        health_band: 'at_risk',
        at_risk_count: 3,
        critical_count: 0,
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/overview`);

    await expect(shellChip(page)).toContainText('At risk');
    // No report → no reported chip. Asserting its absence keeps the two cases
    // above honest about which chip they were reading.
    await expect(page.getByLabel(/^Reported project health:/)).toHaveCount(0);
  });
});

/**
 * #3525 — the popover must explain the word it prints, and an absent band must
 * not render as the reassuring one.
 *
 * The suite above proves the chip reads the SERVER's band. This one covers what
 * that cost: the popover's rows still come from the at-risk / critical counts, so
 * a reported band left a red header sitting above two "0 tasks" rows with no
 * explanation and no route to the report.
 */
test.describe('Health popover explains its own header (#3525)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  /** The chip's popover. */
  async function openPopover(page: Page) {
    await shellChip(page).click();
    const dialog = page.getByRole('dialog', { name: 'Project health' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('a reported Critical over a clean plan names the report and routes to it', async ({
    page,
  }) => {
    await setup(page, {
      health: 'CRITICAL',
      statusSummary: {
        task_count: 6,
        health_band: 'critical',
        health_band_source: 'reported',
        at_risk_count: 0,
        critical_count: 0,
      },
    });

    // Schedule, not Overview: this is the route where the top bar is the ONLY
    // health reading, so a dead-end indicator here has no fallback.
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(shellChip(page)).toContainText('Critical');

    const dialog = await openPopover(page);

    // The header still asserts the server's word...
    await expect(dialog).toContainText('Critical');
    // ...the rows that exist to explain it still say nothing is wrong...
    await expect(dialog).toContainText('0 tasks');
    // ...and the popover now says which of the two the reader is looking at.
    const provenance = dialog.getByTestId('health-provenance-row');
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('Reported by the project manager');

    await provenance.click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview$`));
    await expect(page.getByRole('dialog', { name: 'Project health' })).toBeHidden();
    // The route landed on the surface that owns the report.
    await expect(reportedChip(page, 'Critical')).toBeVisible();
  });

  test('a derived band gets no provenance row — its rows already explain it', async ({ page }) => {
    await setup(page, {
      health: 'AUTO',
      statusSummary: {
        task_count: 9,
        health_band: 'at_risk',
        health_band_source: 'derived',
        at_risk_count: 3,
        critical_count: 0,
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const dialog = await openPopover(page);

    await expect(dialog).toContainText('At risk');
    await expect(dialog.getByTestId('health-provenance-row')).toHaveCount(0);
  });

  test('an AGILE project with a reported band has a drill-through at all', async ({ page }) => {
    // The worst case in the issue: `healthClusterModel` emits sprint / points /
    // velocity for AGILE and no at-risk or critical segment whatsoever, so a
    // Critical chip there had NO drill-through of any kind.
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [
        {
          id: PROJECT_ID,
          name: 'Agile Health Project',
          description: '',
          start_date: '2026-01-01',
          calendar: 'default',
          health: 'CRITICAL',
          methodology: 'AGILE',
        },
      ],
      overview: { schedule_health: 'unknown', total_tasks: 4, critical_task_count: 0 },
      statusSummary: {
        task_count: 4,
        health_band: 'critical',
        health_band_source: 'reported',
        at_risk_count: 0,
        critical_count: 0,
      },
    });

    await page.goto(`/projects/${PROJECT_ID}/board`);
    await expect(shellChip(page)).toContainText('Critical');

    const dialog = await openPopover(page);
    await expect(dialog.getByTestId('health-provenance-row')).toBeVisible();
    // Confirm this really is the AGILE cluster, or the assertion above proves
    // nothing about the methodology that needed it.
    await expect(dialog).not.toContainText('Critical path');
  });

  test('a failed status-summary does NOT render "On track"', async ({ page }) => {
    await setup(page, { health: 'AUTO', statusSummary: {} });
    // Override the mock the setup installed with a 5xx. `data` is `undefined`
    // for this and for an in-flight query alike, which is why the chip used to
    // print the same calm word for both.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/status-summary/`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );

    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    const chip = shellChip(page);
    await expect(chip).toHaveAttribute('data-state', 'unavailable');
    await expect(chip).not.toContainText('On track');
    // Not a band word at all — including the cautious one. There is no value
    // here to be cautious about.
    await expect(chip).not.toContainText('At risk');
    await expect(chip).not.toContainText('Critical');
    await expect(chip).toContainText('Health');

    // It is still a real trigger, and the popover explains the failure rather
    // than listing zeros for counts nobody read.
    const dialog = await openPopover(page);
    await expect(dialog.getByTestId('health-error')).toBeVisible();
    await expect(dialog).toContainText("Couldn't load project health.");
    await expect(dialog).not.toContainText('0 tasks');
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('Retry recovers the chip without reloading the app', async ({ page }) => {
    await setup(page, { health: 'CRITICAL', statusSummary: {} });

    // Fail until the test says otherwise, then serve the real payload — so Retry
    // is proved to re-run the request rather than to reload the page.
    //
    // Gated on a flag the TEST flips, not on a call counter: the app's query
    // client retries a failed request on its own, so a "fail the first call"
    // route is satisfied by React Query's own retry and the chip is already
    // recovered before the assertion runs. The error state has to be held open
    // deliberately or there is nothing for Retry to recover from.
    let failing = true;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/status-summary/`, (route) => {
      if (failing) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_count: 6,
          health_band: 'critical',
          health_band_source: 'reported',
          monte_carlo_p80: null,
          at_risk_count: 0,
          critical_count: 0,
          at_risk_tasks: [],
          critical_tasks: [],
          last_saved: null,
          recalculated_at: null,
        }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(shellChip(page)).toHaveAttribute('data-state', 'unavailable');

    const dialog = await openPopover(page);
    failing = false;
    await dialog.getByRole('button', { name: 'Retry' }).click();

    await expect(shellChip(page)).toContainText('Critical');
    await expect(shellChip(page)).toHaveAttribute('data-health-source', 'reported');
  });
});
