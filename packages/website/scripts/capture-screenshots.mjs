#!/usr/bin/env node
/**
 * Capture product screenshots for the docs site from a running dev stack.
 *
 * The docs (and the marketing site) embed real screenshots of the Atlas
 * Platform Launch demo program. This script is the only source of those
 * images — re-run it after a UI change instead of editing a PNG by hand.
 *
 * Prerequisites
 *   make up                                    # web on :5173, api on :8000
 *   docker compose exec api python manage.py load_sample_project --with-personas
 *
 * Usage
 *   cd packages/website
 *   npm run screenshots                        # every shot → src/assets/screenshots/
 *   npm run screenshots -- --only schedule,board
 *   npm run screenshots -- --list
 *
 * Environment
 *   TRUEPPM_WEB_URL        default http://localhost:5173
 *   TRUEPPM_SHOT_USER      default atlas-alex   (the demo PM persona)
 *   TRUEPPM_SHOT_PASSWORD  default demo         (what --with-personas sets under DEBUG)
 *   TRUEPPM_SHOT_OUT       default <website>/src/assets/screenshots
 *
 * Authentication goes through the API rather than the login form: the form's
 * email-typed input cannot accept a persona *username*, and the token endpoint
 * only accepts usernames. The access token is seeded into the persisted auth
 * store exactly the way the Playwright e2e fixture does it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));

const WEB = (process.env.TRUEPPM_WEB_URL ?? "http://localhost:5173").replace(
  /\/$/,
  "",
);
const USER = process.env.TRUEPPM_SHOT_USER ?? "atlas-alex";
/** A contributor persona for the personal surfaces (My Work, Timesheet) — the
 *  PM has nothing assigned, so those pages would only ever show empty states. */
const MEMBER = process.env.TRUEPPM_SHOT_MEMBER ?? "atlas-tom";
const PASSWORD = process.env.TRUEPPM_SHOT_PASSWORD ?? "demo";
const OUT =
  process.env.TRUEPPM_SHOT_OUT ??
  path.resolve(here, "../src/assets/screenshots");

const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
const WEBP_QUALITY = 82;

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.includes("=")
      ? onlyArg.split("=")[1]
      : args[args.indexOf(onlyArg) + 1]
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

/** Small JSON helper against the API through the web origin (so cookies land there). */
async function api(request, token, pathname) {
  const res = await request.get(`${WEB}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok()) {
    throw new Error(
      `${pathname} → HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res.json();
}

async function login(request, username = USER) {
  const res = await request.post(`${WEB}/api/v1/auth/token/`, {
    data: { username, password: PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(
      `Login as ${username} failed (HTTP ${res.status()}). Seed personas first:\n` +
        "  docker compose exec api python manage.py load_sample_project --with-personas",
    );
  }
  return (await res.json()).access;
}

/** Resolve the Atlas demo program, its three projects, and a task to open. */
async function discover(request, token) {
  const programs = (
    await api(request, token, "/api/v1/programs/?page_size=100")
  ).results;
  const atlas = programs
    .filter((p) => p.name === "Atlas Platform Launch")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!atlas)
    throw new Error(`No "Atlas Platform Launch" program visible to ${USER}.`);

  const projects = (
    await api(request, token, "/api/v1/projects/?page_size=100")
  ).results.filter((p) => p.program === atlas.id);
  const byName = (name) => {
    const p = projects.find((x) => x.name === name);
    if (!p) throw new Error(`Project "${name}" not found in ${atlas.name}.`);
    return p.id;
  };
  const core = byName("Platform Core"); // AGILE
  const migration = byName("Migration Tooling"); // WATERFALL
  const gtm = byName("GTM Readiness"); // HYBRID

  const tasks = (
    await api(
      request,
      token,
      `/api/v1/tasks/?project=${migration}&page_size=100`,
    )
  ).results;
  // A leaf task with dependencies gives the richest detail panel.
  const task =
    tasks.find((t) => t.is_critical && !t.is_summary) ??
    tasks.find((t) => !t.is_summary) ??
    tasks[0];

  return { program: atlas.id, core, migration, gtm, task: task?.id };
}

/**
 * Every shot: name → file, path → route, ready → selector that proves the
 * data-driven page finished rendering (never rely on the chrome alone), and an
 * optional `act` to open a menu or panel before the capture.
 */
function shots(ids) {
  const P = (id, view) => `/projects/${id}/${view}`;
  const G = (view) => `/programs/${ids.program}/${view}`;
  return [
    { name: "login", path: "/login", ready: "form", anonymous: true },
    {
      name: "my-work",
      path: "/me/work",
      ready: "main h1, main h2",
      as: "member",
    },
    {
      name: "programs",
      path: "/programs",
      ready: 'main a[href*="/programs/"]',
    },
    { name: "program-overview", path: G("overview"), ready: "main" },
    {
      name: "program-projects",
      path: G("projects"),
      ready: 'main a[href*="/projects/"]',
    },
    {
      name: "program-schedule",
      path: G("schedule"),
      ready: 'main canvas, main [role="grid"]',
    },
    { name: "program-resources", path: G("resources"), ready: "main" },
    { name: "project-overview", path: P(ids.core, "overview"), ready: "main" },
    {
      name: "schedule",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
    },
    {
      name: "schedule-hybrid",
      path: P(ids.gtm, "schedule"),
      ready: "main canvas",
    },
    {
      name: "schedule-timeline",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
      act: async (page) => {
        await page
          .getByRole("radio", { name: "Timeline", exact: true })
          .click();
        await page.waitForTimeout(800);
      },
    },
    {
      name: "monte-carlo",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
      settleMs: 1500,
      act: runMonteCarlo,
    },
    { name: "grid", path: P(ids.migration, "grid"), ready: "main" },
    {
      name: "board",
      path: P(ids.core, "board"),
      ready: 'main [data-testid*="board"], main [role="list"], main h2',
    },
    { name: "sprints", path: P(ids.core, "sprints"), ready: "main" },
    {
      name: "product-backlog",
      path: P(ids.core, "product-backlog"),
      ready: "main",
    },
    { name: "calendar", path: P(ids.migration, "calendar"), ready: "main" },
    {
      name: "resources-roster",
      path: P(ids.core, "resources/roster"),
      ready: "main",
    },
    {
      name: "resources-heatmap",
      path: P(ids.core, "resources/heatmap"),
      ready: "main",
    },
    { name: "risk-register", path: P(ids.migration, "risk"), ready: "main" },
    { name: "reports", path: P(ids.core, "reports"), ready: "main" },
    { name: "activity", path: P(ids.core, "activity"), ready: "main" },
    { name: "assets", path: P(ids.core, "assets"), ready: "main" },
    ...(ids.task
      ? [
          {
            name: "task-detail",
            path: P(ids.migration, `tasks/${ids.task}`),
            ready: "main",
          },
        ]
      : []),
    {
      name: "project-settings",
      path: P(ids.core, "settings/general"),
      ready: "main form, main",
    },
    {
      name: "project-settings-methodology",
      path: P(ids.core, "settings/methodology"),
      ready: "main",
    },
    { name: "timesheet", path: "/me/timesheet", ready: "main", as: "member" },
    { name: "notifications", path: "/me/notifications", ready: "main" },
    { name: "api-tokens", path: "/me/settings/api-tokens", ready: "main" },
    {
      name: "connected-accounts",
      path: "/me/settings/connected-accounts",
      ready: "main",
    },
    {
      name: "command-palette",
      path: P(ids.core, "overview"),
      ready: "main",
      act: async (page) => {
        await page.keyboard.press("ControlOrMeta+k");
        await page.waitForSelector(
          '[role="dialog"], [cmdk-root], [role="combobox"]',
          {
            timeout: 5000,
          },
        );
      },
    },
  ];
}

/** Run a Monte Carlo simulation on the currently-open schedule and wait for the
 *  forecast bar to render its P50/P80/P95 result. Shared by the full-page
 *  `monte-carlo` shot and the `monte-carlo-*` component crops below. */
async function runMonteCarlo(page) {
  const run = page.getByRole("button", { name: /Run Monte Carlo/i }).first();
  if (await run.isVisible().catch(() => false)) {
    await run.click();
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});
    await page
      .getByText(/P80/)
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    await page.waitForTimeout(1200);
  }
}

/**
 * Component-level crops (issue #3729): zoom into the single control a docs
 * page is describing instead of a full 1600×1000 page, which shrinks to
 * illegibility in the narrow content column. Each entry reuses the same
 * `path`/`ready`/`act` shape as `shots()` above, plus a `crop` locator
 * resolved after `ready` + `act` settle. `cropPad` (CSS px, pre-scale) adds
 * breathing room around the element so the control isn't cut flush to the
 * image edge; the clip is clamped to the viewport in `main()`.
 */
function componentShots(ids) {
  const P = (id, view) => `/projects/${id}/${view}`;
  return [
    {
      name: "schedule-toolbar",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
      crop: (page) => page.getByRole("toolbar", { name: "Schedule toolbar" }),
      cropPad: 12,
    },
    ...(ids.task
      ? [
          {
            name: "task-detail-dependencies",
            path: P(ids.migration, `tasks/${ids.task}`),
            ready: "main",
            act: async (page) => {
              await page
                .locator('[data-section-id="dependencies"] button')
                .first()
                .click();
              await page.waitForTimeout(300);
            },
            crop: (page) => page.locator('[data-section-id="dependencies"]'),
            cropPad: 12,
          },
          {
            name: "task-detail-baseline",
            path: P(ids.migration, `tasks/${ids.task}`),
            ready: "main",
            act: async (page) => {
              await page
                .locator('[data-section-id="baseline"] button')
                .first()
                .click();
              // Comparison table fetches after the section opens; wait for it
              // (or the empty-state CTA) rather than a fixed delay, so the
              // crop's bounding box is measured against the settled height.
              await Promise.race([
                page
                  .getByRole("table", { name: "Baseline comparison" })
                  .waitFor({ timeout: 8000 }),
                page
                  .getByRole("button", { name: /capture/i })
                  .waitFor({ timeout: 8000 }),
              ]).catch(() => {});
              await page.waitForTimeout(300);
            },
            crop: (page) => page.locator('[data-section-id="baseline"]'),
            cropPad: 12,
          },
          {
            name: "dependency-editor",
            path: P(ids.migration, `tasks/${ids.task}`),
            ready: "main",
            act: async (page) => {
              await page
                .locator('[data-section-id="dependencies"] button')
                .first()
                .click();
              await page.waitForTimeout(300);
              await page
                .getByRole("button", { name: /Search another project/ })
                .first()
                .click();
              await page
                .getByRole("dialog")
                .last()
                .waitFor({ state: "visible", timeout: 5000 });
              await page.waitForTimeout(300);
            },
            crop: (page) => page.getByRole("dialog").last(),
            cropPad: 8,
          },
        ]
      : []),
    {
      name: "board-card",
      path: P(ids.core, "board"),
      ready: 'main [data-testid*="board"], main [role="list"], main h2',
      crop: (page) =>
        page.locator('[role="button"][aria-label*="% complete"]').first(),
      cropPad: 10,
    },
    {
      name: "board-column-header",
      path: P(ids.core, "board"),
      ready: 'main [data-testid*="board"], main [role="list"], main h2',
      crop: (page) => page.locator("[data-wip-state]").first(),
      cropPad: 8,
    },
    {
      name: "sprint-plan-dialog",
      path: P(ids.core, "sprints"),
      ready: "main",
      act: async (page) => {
        // "Plan next" disables once a planned sprint exists (the Atlas sample
        // usually has one already) — the timeline strip's plain "Edit" button
        // opens the same PlanSprintModal against that planned sprint instead.
        const planNext = page
          .getByRole("button", { name: /^Plan next/i })
          .first();
        if (await planNext.isEnabled().catch(() => false)) {
          await planNext.click();
        } else {
          await page
            .locator('[aria-labelledby="sprint-timeline-heading"]')
            .getByRole("button", { name: "Edit", exact: true })
            .first()
            .click();
        }
        await page
          .getByRole("dialog")
          .first()
          .waitFor({ state: "visible", timeout: 5000 });
      },
      crop: (page) => page.getByRole("dialog").first(),
      cropPad: 10,
    },
    {
      name: "sprint-close-dialog",
      path: P(ids.core, "sprints"),
      ready: "main",
      act: async (page) => {
        const btn = page
          .getByRole("button", { name: /^Close active/i })
          .first();
        if (!(await btn.isEnabled().catch(() => false))) {
          throw new Error(
            "Close-active-sprint button is disabled (no active sprint)",
          );
        }
        await btn.click();
        await page
          .getByRole("dialog")
          .first()
          .waitFor({ state: "visible", timeout: 5000 });
      },
      // CloseSprintDialog's `role="dialog"` sits on the `fixed inset-0`
      // backdrop wrapper, not the visible panel — crop its first child (the
      // actual `w-[440px]` card) or the clip is the whole viewport.
      crop: (page) =>
        page.getByRole("dialog").first().locator(":scope > div").first(),
      cropPad: 10,
    },
    {
      name: "monte-carlo-histogram",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
      settleMs: 1500,
      act: async (page) => {
        await runMonteCarlo(page);
        // The histogram only renders in the forecast bar's expanded body, not
        // its collapsed chip row or the separate Details dialog.
        await page
          .getByRole("button", { name: "Maximize forecast detail" })
          .click();
        await page
          .getByRole("img", { name: /Monte Carlo distribution/ })
          .first()
          .waitFor({ timeout: 8000 });
      },
      crop: (page) =>
        page.getByRole("img", { name: /Monte Carlo distribution/ }).first(),
      cropPad: 12,
    },
    {
      name: "monte-carlo-detail-panel",
      path: P(ids.migration, "schedule"),
      ready: "main canvas",
      settleMs: 1500,
      act: async (page) => {
        await runMonteCarlo(page);
        await page
          .getByRole("button", { name: "Open Monte Carlo detail panel" })
          .click();
        await page
          .locator('[data-testid="mc-detail-panel"]')
          .waitFor({ state: "visible", timeout: 5000 });
      },
      crop: (page) => page.locator('[data-testid="mc-detail-panel"]'),
      cropPad: 10,
    },
    {
      name: "command-palette-panel",
      path: P(ids.core, "overview"),
      ready: "main",
      act: async (page) => {
        await page.keyboard.press("ControlOrMeta+k");
        await page
          .getByRole("dialog", { name: "Command palette" })
          .waitFor({ timeout: 5000 });
      },
      crop: (page) => page.getByRole("dialog", { name: "Command palette" }),
      cropPad: 10,
    },
    {
      name: "risk-editor",
      path: P(ids.migration, "risk"),
      ready: "main",
      act: async (page) => {
        await page
          .getByRole("button", { name: /^Edit risk:/ })
          .first()
          .click();
        await page
          .getByRole("dialog")
          .first()
          .waitFor({ state: "visible", timeout: 5000 });
      },
      crop: (page) => page.getByRole("dialog").first(),
      cropPad: 10,
    },
    {
      name: "risk-matrix",
      path: P(ids.migration, "risk"),
      ready: "main",
      crop: (page) => page.getByRole("grid", { name: "Risk matrix" }),
      cropPad: 12,
    },
    {
      name: "timesheet-grid",
      path: "/me/timesheet",
      ready: "main",
      as: "member",
      crop: (page) => page.getByRole("grid", { name: "Weekly timesheet" }),
      cropPad: 10,
    },
    {
      name: "notification-panel",
      path: P(ids.core, "overview"),
      ready: "main",
      act: async (page) => {
        await page
          .getByRole("button", { name: /^Notifications/ })
          .first()
          .click();
        await page
          .getByRole("dialog", { name: "Notifications" })
          .waitFor({ timeout: 5000 });
      },
      crop: (page) => page.getByRole("dialog", { name: "Notifications" }),
      cropPad: 10,
    },
    {
      name: "resource-heatmap-cells",
      path: P(ids.core, "resources/heatmap"),
      ready: "main",
      crop: (page) =>
        page.getByRole("grid", { name: "Resource utilization heatmap" }),
      cropPad: 10,
    },
    {
      name: "methodology-selector",
      path: P(ids.core, "settings/methodology"),
      ready: "main",
      crop: (page) =>
        page.locator('[role="radiogroup"][aria-labelledby="method-heading"]'),
      cropPad: 10,
    },
  ];
}

/** Close the one-off teaching surfaces that would otherwise cover the content. */
async function tidy(page) {
  const clickIfVisible = async (selector) => {
    const el = page.locator(selector).first();
    if (await el.isVisible().catch(() => false)) await el.click();
  };
  await clickIfVisible(
    '[role="status"] button[aria-label*="ismiss"], [role="status"] button[aria-label*="lose"]',
  );
  await clickIfVisible('button[aria-label^="Hide the how-to bar"]');
  const legend = page.locator(
    '[data-testid="schedule-legend-chip"][aria-expanded="true"]',
  );
  if (await legend.isVisible().catch(() => false)) await legend.click();
}

async function settle(page, shot) {
  await page.waitForLoadState("domcontentloaded");
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {});
  if (shot.ready) {
    await page.waitForSelector(shot.ready, {
      timeout: 20_000,
      state: "visible",
    });
  }
  // Fonts + one more paint; canvases (Gantt) draw after their data lands.
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(shot.settleMs ?? 1200);
}

async function main() {
  const browser = await chromium.launch();
  const baseContext = () =>
    browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "America/New_York",
    });

  const seedAuth = (accessToken) => {
    localStorage.setItem(
      "trueppm-auth",
      JSON.stringify({
        state: { isAuthenticated: true, accessToken },
        version: 0,
      }),
    );
    // First-run prompts belong in the product, not in every screenshot.
    localStorage.setItem("trueppm.landingPromptSeen", "1");
    localStorage.setItem("trueppm.gantt.unscheduledGutter.collapsed", "true");
  };

  const authed = await baseContext();
  const token = await login(authed.request);
  const ids = await discover(authed.request, token);
  await authed.addInitScript(seedAuth, token);

  const member = await baseContext();
  await member.addInitScript(seedAuth, await login(member.request, MEMBER));

  const anon = await baseContext();

  const all = [...shots(ids), ...componentShots(ids)];
  const selected = only ? all.filter((s) => only.includes(s.name)) : all;
  if (only) {
    const missing = only.filter((n) => !all.some((s) => s.name === n));
    if (missing.length)
      throw new Error(`Unknown shot(s): ${missing.join(", ")}`);
  }
  if (listOnly) {
    for (const s of all) console.log(`${s.name.padEnd(30)} ${s.path}`);
    await browser.close();
    return;
  }

  await mkdir(OUT, { recursive: true });
  const failures = [];
  for (const shot of selected) {
    const ctx = shot.anonymous ? anon : shot.as === "member" ? member : authed;
    const page = await ctx.newPage();
    try {
      await page.goto(`${WEB}${shot.path}`);
      await settle(page, shot);
      await tidy(page);
      if (shot.act) {
        await shot.act(page);
        await page.waitForTimeout(400);
      }
      await page.addStyleTag({
        content: "* { caret-color: transparent !important; }",
      });
      let png;
      if (shot.crop) {
        const target = await shot.crop(page);
        await target.waitFor({ state: "visible", timeout: 10_000 });
        // page.screenshot({clip}) does not auto-scroll (unlike locator.screenshot());
        // a crop target below the fold — e.g. the last collapsible section on a
        // long task-detail page — must be scrolled into view first or the clip
        // clamps to whatever sliver of it is still inside the viewport.
        await target.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        const box = await target.boundingBox();
        if (!box)
          throw new Error(
            "crop target resolved but has no bounding box (hidden?)",
          );
        const pad = shot.cropPad ?? 16;
        const vp = page.viewportSize();
        const x = Math.max(0, box.x - pad);
        const y = Math.max(0, box.y - pad);
        const clip = {
          x,
          y,
          width: Math.min(vp.width - x, box.width + pad * 2),
          height: Math.min(vp.height - y, box.height + pad * 2),
        };
        png = await page.screenshot({ type: "png", clip });
      } else {
        png = await page.screenshot({ type: "png", fullPage: false });
      }
      const out = path.join(OUT, `${shot.name}.webp`);
      const webp = await sharp(png).webp({ quality: WEBP_QUALITY }).toBuffer();
      await writeFile(out, webp);
      console.log(
        `✓ ${shot.name.padEnd(30)} ${(webp.length / 1024).toFixed(0).padStart(4)} KB  ${shot.path}`,
      );
    } catch (err) {
      failures.push(shot.name);
      console.error(`✗ ${shot.name}: ${err.message.split("\n")[0]}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  if (failures.length) {
    console.error(
      `\n${failures.length} shot(s) failed: ${failures.join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
