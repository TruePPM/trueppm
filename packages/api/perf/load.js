// Nightly perf/load regression harness for TruePPM's hot read endpoints (#2280).
//
// This is a RELATIVE-regression harness, not a capacity test. It runs against a
// single in-pipeline uvicorn process on shared CI hardware, so the absolute
// numbers are not representative of production — their value is the trend across
// nightly runs (same harness, same seed) and the gross-regression tripwires in
// `thresholds` below (a new N+1, a dropped index, an accidental full-table scan).
// Tighten the thresholds only when this runs against dedicated, quiet hardware.
//
// Endpoints mirror QA plan §9: project list (#1482 N+1 path), task list, program
// list, and the sync delta. The task/sync reads are data-driven off whatever the
// seed created, so the script adapts to the fixture without hard-coded UUIDs.
//
// FIXTURE SIZE IS PART OF THE MEASUREMENT. Until #2816 this script targeted
// `results[0]` of /projects/, which in CI was `seed_integration_fixtures`' project
// — a project holding exactly ONE task. Every `task_list` number the nightly ever
// reported was the latency of serializing one row, so none of the three regression
// classes named above was detectable: on one row a dropped index and a full-table
// scan produce the same plan, and an N+1 is one extra query. That is why #2767's
// 683 → 2225 ms swing survived a 20-commit bisect — no data-scale hypothesis can
// move a one-row query, and the real cause was per-request fixed cost plus runner
// contention. CI now also seeds a 1,000-task capacity project and this script
// targets it BY NAME, and the digest prints the row count it actually measured so
// the next investigation starts from the fixture size instead of guessing at it.
//
// Env:
//   BASE_URL           target origin (default http://127.0.0.1:8000)
//   PERF_TOKEN         JWT access token for an authenticated caller (required for
//                      real data; without it the endpoints 401 and the run
//                      measures the auth reject path only)
//   PERF_VUS           peak virtual users (default 20)
//   PERF_PROJECT_NAME  name of the project to target for the task/sync reads
//                      (default "Capacity project 1", what `seed_capacity` calls
//                      its first project). Falls back to the first project the
//                      caller can see, with a warning.

import http from "k6/http";
import { check, sleep } from "k6";
import { Gauge } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:8000";
const TOKEN = __ENV.PERF_TOKEN || "";
const PEAK_VUS = Number(__ENV.PERF_VUS || "20");
const PROJECT_NAME = __ENV.PERF_PROJECT_NAME || "Capacity project 1";

// What the Schedule view actually asks for: `useScheduleTasks` requests page 1 at
// page_size=200 and fetches the remainder by explicit page number. Measuring the
// default 50 would measure a request the product does not make.
const TASK_PAGE_SIZE = 200;

// Row count behind the measured task list, published in the digest and in
// perf-summary.json. A p95 without its fixture size is the #2816 defect: a number
// that looks like a trend line and is not comparable to anything.
const fixtureTaskCount = new Gauge("fixture_task_count");

const PARAMS = {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
};

// k6's script transform (goja + a pinned Babel) does not support object spread,
// so `{ ...PARAMS, tags }` fails to parse. Build per-request params explicitly.
function taggedParams(endpoint) {
  return { headers: PARAMS.headers, tags: { endpoint } };
}

// A threshold expression that exists only to make k6 record a tagged submetric,
// never to gate it. True of every sample, so it can never breach. `handleSummary`
// treats an endpoint whose only threshold is this one as `untracked` rather than
// reporting a meaningless budget of 0.
const UNTRACKED_EXPR = "p(95)>=0";

export const options = {
  scenarios: {
    hot_reads: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: PEAK_VUS }, // ramp
        { duration: "30s", target: PEAK_VUS }, // sustain
        { duration: "10s", target: 0 }, // ramp down
      ],
    },
  },
  thresholds: {
    // Loose tripwires — see the file header on why these are not SLAs. k6 exits
    // non-zero if any threshold is breached; the CI job is `allow_failure: true`,
    // so a breach surfaces as a warning + artifact, never a red merge gate.
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:project_list}": ["p(95)<1500"],
    "http_req_duration{endpoint:program_list}": ["p(95)<1500"],
    // TODO(#2826): both task rows ship untracked and need a budget derived from
    // the first ~5 nightlies against the 1,000-task fixture.
    //
    // The previous `p(95)<2000` is deleted rather than carried over because it was
    // calibrated to serializing ONE row (#2816). Against a 200-row page it would
    // breach every single night, and a tripwire that always fires is worse than no
    // tripwire — that is precisely what made #2767 un-bisectable. No honest budget
    // exists yet: nobody has measured this endpoint at this fixture size on this
    // hardware. Measure first, then gate.
    "http_req_duration{endpoint:task_list}": [UNTRACKED_EXPR],
    // The OFFSET cliff from #2814 (~570 ms at page 1, ~4,900 ms at page 70 on a
    // 4,000-task project), on the trend line rather than found by a user.
    "http_req_duration{endpoint:task_list_deep}": [UNTRACKED_EXPR],
    // Not a budget. k6 only materializes a tagged submetric when a threshold
    // references the tag, so without this line `sync_delta` is requested on every
    // iteration and reported nowhere: it never reaches `data.metrics`, never
    // reaches perf-summary.json, and cannot be printed. `p(95)>=0` is true of any
    // sample, so it buys the submetric — and the trend line the digest prints —
    // without inventing an SLA for an endpoint we have never actually measured.
    // Replace with a real budget once a few nightlies establish its range; the
    // digest labels it `untracked` until then (see UNTRACKED_EXPR).
    "http_req_duration{endpoint:sync_delta}": [UNTRACKED_EXPR],
  },
};

// Walk every page of /projects/ collecting `{id, name}`. The capacity fixture is
// not guaranteed to be on page 1 — and picking whatever landed first is the bug
// this file exists to stop repeating.
function listAllProjects() {
  const projects = [];
  let url = `${BASE}/api/v1/projects/?page_size=100`;
  // Bounded so a malformed `next` cursor cannot spin setup() forever.
  for (let guard = 0; guard < 50 && url; guard++) {
    const res = http.get(url, PARAMS);
    if (res.status !== 200) {
      console.warn(`setup: ${url} returned ${res.status}`);
      return { projects: projects, ok: false };
    }
    const body = res.json();
    const results = Array.isArray(body) ? body : body.results || [];
    for (let i = 0; i < results.length; i++) projects.push(results[i]);
    url = Array.isArray(body) ? null : body.next || null;
  }
  return { projects: projects, ok: true };
}

/**
 * Resolve the target project ONCE, by name, and measure how big it actually is.
 *
 * Returned value is handed to every VU's default function.
 *
 * Resolving by name rather than by `results[0]` is load-bearing in two ways.
 * With two projects seeded, `results[0]` is whichever the list happens to order
 * first, so the measured endpoint would depend on list ordering — and !1953 has
 * already changed task ordering once. It is also what silently pinned this
 * harness to a one-task project for its entire life (#2816).
 */
export function setup() {
  const listed = listAllProjects();
  if (!listed.ok && !listed.projects.length) {
    console.warn("setup: could not list projects; task/sync reads are skipped");
    return { projectId: null, taskCount: 0, deepPage: 1 };
  }

  let target = null;
  for (let i = 0; i < listed.projects.length; i++) {
    if (listed.projects[i].name === PROJECT_NAME) {
      target = listed.projects[i];
      break;
    }
  }

  if (!target) {
    // Deliberately loud. A silent fallback here is how the harness spent its
    // whole life reporting a one-row p95 as a task-list trend (#2816): locally
    // this is a convenience, but in CI it means the capacity seed did not run and
    // the numbers are not comparable to any other night.
    console.warn(
      `setup: no project named "${PROJECT_NAME}" — falling back to the first ` +
        "visible project. task_list numbers are NOT comparable to a run that " +
        "found the capacity fixture. Check that seed_capacity ran and that the " +
        "authenticated user is a member of its project.",
    );
    target = listed.projects.length ? listed.projects[0] : null;
  }

  if (!target) {
    console.warn("setup: no visible projects; task/sync reads are skipped");
    return { projectId: null, taskCount: 0, deepPage: 1 };
  }

  // One probe read to learn the fixture size, so the digest can publish it and so
  // `task_list_deep` targets the genuinely last page rather than a guessed one.
  let taskCount = 0;
  const probe = http.get(
    `${BASE}/api/v1/tasks/?project=${target.id}&page_size=1`,
    PARAMS,
  );
  if (probe.status === 200) {
    const body = probe.json();
    taskCount = Array.isArray(body) ? body.length : body.count || 0;
  } else {
    console.warn(`setup: task probe returned ${probe.status}`);
  }

  const deepPage = Math.max(1, Math.ceil(taskCount / TASK_PAGE_SIZE));
  console.log(
    `setup: targeting "${target.name}" (${taskCount} tasks, ` +
      `deep page ${deepPage} @ page_size=${TASK_PAGE_SIZE})`,
  );

  return { projectId: target.id, taskCount: taskCount, deepPage: deepPage };
}

export default function (data) {
  const projectList = http.get(
    `${BASE}/api/v1/projects/`,
    taggedParams("project_list"),
  );
  check(projectList, { "project list 200": (r) => r.status === 200 });

  const programList = http.get(
    `${BASE}/api/v1/programs/`,
    taggedParams("program_list"),
  );
  check(programList, { "program list 200": (r) => r.status === 200 });

  if (data.projectId) {
    // Emitted every iteration rather than once in setup(): a Gauge holds the last
    // value written, every write here is identical, and this is the only path
    // guaranteed to reach `data.metrics` in handleSummary().
    fixtureTaskCount.add(data.taskCount);

    const taskList = http.get(
      `${BASE}/api/v1/tasks/?project=${data.projectId}&page_size=${TASK_PAGE_SIZE}`,
      taggedParams("task_list"),
    );
    check(taskList, { "task list 200": (r) => r.status === 200 });

    // Same page size, last page. The gap between this and `task_list` IS the
    // OFFSET cost — reading them as a pair is the point (#2814).
    const taskListDeep = http.get(
      `${BASE}/api/v1/tasks/?project=${data.projectId}` +
        `&page_size=${TASK_PAGE_SIZE}&page=${data.deepPage}`,
      taggedParams("task_list_deep"),
    );
    check(taskListDeep, { "task list deep 200": (r) => r.status === 200 });

    http.get(
      `${BASE}/api/v1/projects/${data.projectId}/sync/`,
      taggedParams("sync_delta"),
    );
  }

  sleep(1);
}

// Matches the tagged submetric k6 records per endpoint, e.g.
// `http_req_duration{endpoint:task_list}` → `task_list`.
const ENDPOINT_METRIC_RE = /^http_req_duration\{endpoint:([^}]+)\}$/;

// Pulls the budget out of a `p(95)<2000`-style threshold expression.
const P95_BUDGET_RE = /p\(95\)\s*<\s*(\d+(?:\.\d+)?)/;

// goja + k6's pinned Babel is an old target; hand-rolled rather than relying on
// String.prototype.padStart/padEnd being present.
function padRight(value, width) {
  let out = String(value);
  while (out.length < width) out += " ";
  return out;
}

function padLeft(value, width) {
  let out = String(value);
  while (out.length < width) out = " " + out;
  return out;
}

/**
 * One digest row per endpoint k6 recorded a tagged submetric for.
 *
 * Derived from `data.metrics` rather than from a second hard-coded endpoint list:
 * a submetric exists if and only if `options.thresholds` references its tag, so
 * walking the metrics *is* walking the thresholds, and a threshold added later
 * cannot be silently missing from the digest.
 */
function endpointRows(metrics) {
  const rows = [];
  const names = Object.keys(metrics)
    .filter((name) => ENDPOINT_METRIC_RE.test(name))
    .sort((a, b) => a.localeCompare(b));

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const metric = metrics[name] || {};
    const values = metric.values || {};
    const thresholds = metric.thresholds || {};
    const exprs = Object.keys(thresholds);

    let budget = null;
    let breached = false;
    for (let j = 0; j < exprs.length; j++) {
      const expr = exprs[j];
      if (expr === UNTRACKED_EXPR) continue;
      const match = P95_BUDGET_RE.exec(expr);
      if (match) budget = Number(match[1]);
      // k6 reports the verdict itself — never re-derive it from the value, or the
      // digest can disagree with the exit code that actually gates the job.
      if (thresholds[expr] && thresholds[expr].ok === false) breached = true;
    }

    rows.push({
      endpoint: ENDPOINT_METRIC_RE.exec(name)[1],
      p95: typeof values["p(95)"] === "number" ? values["p(95)"] : null,
      budget: budget,
      breached: breached,
    });
  }
  return rows;
}

function formatRows(rows) {
  let width = 0;
  for (let i = 0; i < rows.length; i++) {
    width = Math.max(width, rows[i].endpoint.length);
  }

  return rows.map((row) => {
    const measured = row.p95 === null ? "n/a" : String(Math.round(row.p95));
    const label =
      "  " + padRight(row.endpoint, width) + "  " + padLeft(measured, 6);

    if (row.budget === null) {
      return label + "  /     --  untracked";
    }
    let verdict = "ok";
    if (row.breached) {
      const over = Math.round(((row.p95 - row.budget) / row.budget) * 100);
      verdict = "BREACH (+" + over + "%)";
    }
    return label + "  / " + padLeft(row.budget, 6) + "  " + verdict;
  });
}

// Self-contained summary — no jslib import (CI has no outbound network budget for
// it). Writes the full k6 metrics blob as an artifact and prints a compact digest
// to the job log.
//
// The digest reports p95 **per endpoint against its own budget**, because that is
// what `options.thresholds` gates on. It previously printed only the untagged
// `http_req_duration` p95 — an average across all endpoints that no threshold
// uses — so a breach showed a number that was neither the one that failed nor
// comparable to the budget it failed against, and triaging a regression meant
// downloading perf-summary.json from every pipeline and parsing it by hand
// (#2769).
export function handleSummary(data) {
  const m = data.metrics;
  const p95 = (name) =>
    m[name] && m[name].values ? Math.round(m[name].values["p(95)"]) : "n/a";
  const failRate =
    m.http_req_failed && m.http_req_failed.values
      ? (m.http_req_failed.values.rate * 100).toFixed(2)
      : "n/a";
  const iterations =
    m.iterations && m.iterations.values ? m.iterations.values.count : "n/a";
  // Printed on every run, breach or not. The p95 rows below are meaningless
  // without it: a task-list latency is only comparable to another night's if both
  // measured the same number of rows (#2816).
  const fixtureTasks =
    m.fixture_task_count && m.fixture_task_count.values
      ? m.fixture_task_count.values.value
      : "n/a";

  const rows = endpointRows(m);
  const breaches = rows.filter((row) => row.breached);

  const digest = [
    "",
    "=== TruePPM perf/load digest ===",
    `iterations:            ${iterations}`,
    `http_req_failed:       ${failRate}%`,
    `task_list fixture:     ${fixtureTasks} tasks`,
    `p95 all endpoints:     ${p95("http_req_duration")} ms  (aggregate — not gated)`,
    "",
    "p95 by endpoint (ms):",
  ]
    .concat(formatRows(rows))
    .concat([
      "",
      breaches.length
        ? `RESULT: ${breaches.length} threshold breach(es) — see above`
        : "RESULT: all endpoint thresholds within budget",
      "================================",
      "",
    ])
    .join("\n");

  return {
    "perf-summary.json": JSON.stringify(data, null, 2),
    stdout: digest,
  };
}
