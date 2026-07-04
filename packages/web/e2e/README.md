# End-to-end specs (`packages/web/e2e`)

Playwright specs for the web app. Two surfaces live here:

- **Regression specs** — the `*.spec.ts` files run by the CI `web:e2e` job via the
  default `playwright.config.ts`. They mock the API (see
  [`fixtures/README.md`](./fixtures/README.md) for the pattern) and gate every MR.
- **Marketing shots** — `marketing-shots.spec.ts` + `playwright.marketing.config.ts`,
  a maintained product-screenshot generator (issue #380). It is **not** part of
  `web:e2e` — it runs only on demand and never blocks a pipeline.

---

## Marketing product shots

`marketing-shots.spec.ts` regenerates a deterministic set of product views to
`~/Downloads` for the marketing site, pitch deck, and README.

### How it stays deterministic

- **Every API call is mocked** to seeded fixture data (the `setup()` helper reuses
  the shared `fixtures/` mocks plus rich per-view overrides).
- **The wall-clock is pinned** to `2026-05-07` via `page.clock.setFixedTime`, so
  date-relative surfaces (the Schedule "today" line, the Resources rolling ±4-week
  window, any relative copy) render identically on every run, on any machine, on
  any calendar day.
- **Single worker, no parallelism** (config) keeps run order stable.

So a single command produces byte-stable output.

### Run it

The dev server must already be serving the app on `http://localhost:5173`.

```bash
# 1. Start the app (either works):
make up                     # docker compose — web HMR on :5173
# or
cd packages/web && npm run dev

# 2. Regenerate the shots (from repo root):
make screenshots
# or from packages/web:
npm run screenshots
# or the raw invocation:
npx playwright test --config=playwright.marketing.config.ts
```

> **Node version:** the repo's default Node may be too old for the toolchain.
> If lint/build complains, use Node 24 first:
> `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.

Output PNGs land in `~/Downloads/trueppm-*.png`.

### Shot inventory

Coverage follows the full canonical view-tab order (web-rule 108):
**Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks.**

| File | View | Notes |
|------|------|-------|
| `trueppm-01-overview.png`     | Overview  | KPI cards, attention + my-tasks panels |
| `trueppm-02-board.png`        | Board     | Kanban with phases × status |
| `trueppm-03-schedule.png`     | Schedule  | Canvas Gantt, critical path, dependencies |
| `trueppm-04-grid.png`         | Grid      | WBS + Table successor (ADR-0053); Outline mode on WATERFALL |
| `trueppm-05-calendar.png`     | Calendar  | Anchored to May 2026 |
| `trueppm-06-team.png`         | Team      | Resource utilization heat-map (issue #22) |
| `trueppm-07-risks.png`        | Risks     | Register + matrix |
| `trueppm-08-mobile-board.png` | Mobile hero | Board reflow, 375×812 @3× (web-rule 193) |

**WBS and Table** are no longer separate tabs — they shipped then consolidated into
the unified **Grid** view (ADR-0053: `/wbs` and `/list` redirect to `/grid`). They
are kept in the spec as annotated `test.skip()` placeholders so all eight canonical
positions stay documented; the single Grid shot (04) represents both. Any genuinely
un-shipped future tab should follow the same convention — a `test.skip()` annotated
with its tracking issue rather than a deleted slot.

### Adding a shot

1. Add fixture data (or reuse the existing `TASKS` / `RISKS` / etc.).
2. Mock any endpoint the target view reads with its **real** response shape — a
   data-driven page that hits an unmocked object endpoint falls through the
   catch-all and renders the error boundary (see the root `CLAUDE.md` note on the
   `**/api/v1/**` catch-all).
3. Gate the screenshot on a "page rendered" signal (a heading/region/group that
   only appears after the reads resolve), then `page.screenshot(...)`.
