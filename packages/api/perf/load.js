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
// Env:
//   BASE_URL    target origin (default http://127.0.0.1:8000)
//   PERF_TOKEN  JWT access token for an authenticated caller (required for real
//               data; without it the endpoints 401 and the run measures the auth
//               reject path only)
//   PERF_VUS    peak virtual users (default 20)

import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:8000";
const TOKEN = __ENV.PERF_TOKEN || "";
const PEAK_VUS = Number(__ENV.PERF_VUS || "20");

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
    "http_req_duration{endpoint:task_list}": ["p(95)<2000"],
    "http_req_duration{endpoint:program_list}": ["p(95)<1500"],
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

// Resolve a project id once so the per-iteration task/sync reads have a real
// target. Returned value is handed to every VU's default function.
export function setup() {
  const res = http.get(`${BASE}/api/v1/projects/`, PARAMS);
  if (res.status !== 200) {
    console.warn(
      `setup: /projects/ returned ${res.status}; task/sync reads will be skipped`,
    );
    return { projectId: null };
  }
  const body = res.json();
  const results = Array.isArray(body) ? body : body.results || [];
  return { projectId: results.length ? results[0].id : null };
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
    const taskList = http.get(
      `${BASE}/api/v1/tasks/?project=${data.projectId}`,
      taggedParams("task_list"),
    );
    check(taskList, { "task list 200": (r) => r.status === 200 });

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

  const rows = endpointRows(m);
  const breaches = rows.filter((row) => row.breached);

  const digest = [
    "",
    "=== TruePPM perf/load digest ===",
    `iterations:            ${iterations}`,
    `http_req_failed:       ${failRate}%`,
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
