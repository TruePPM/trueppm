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
