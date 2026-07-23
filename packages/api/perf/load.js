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

// Self-contained summary — no jslib import (CI has no outbound network budget for
// it). Writes the full k6 metrics blob as an artifact and prints a compact digest
// to the job log.
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

  const digest = [
    "",
    "=== TruePPM perf/load digest ===",
    `iterations:        ${iterations}`,
    `http_req_failed:   ${failRate}%`,
    `http_req p95 (ms): ${p95("http_req_duration")}`,
    "================================",
    "",
  ].join("\n");

  return {
    "perf-summary.json": JSON.stringify(data, null, 2),
    stdout: digest,
  };
}
