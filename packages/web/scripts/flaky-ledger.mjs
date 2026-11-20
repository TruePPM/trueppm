#!/usr/bin/env node
// Flaky ledger: one append-only JSONL file of flake observations (#2754).
//
// check-flaky.mjs only sees fail→pass WITHIN one job. It cannot see a job that
// failed and was then retried to green (a job-level retry), and it logs rather
// than persists, so a test that flakes weekly looks like unrelated one-offs.
// This script adds both: a persisted ledger and a job-level retry detector.
//
// SHARED CONTRACT (the nightly --repeat-each run in #3547 must append to the
// same artifact instead of inventing a second one). Each line is JSON:
//   { schema: 1, kind, date, sha, pipeline, job, test?, file? }
// where `kind` is one of
//   "retry-pass"  a test failed then passed on a Playwright retry (check-flaky)
//   "job-retry"   a CI job has both a failed and a success run for one sha
//   "repeat-fail" a test failed under --repeat-each (reserved for #3547)
// Entries are de-duplicated on (kind, sha, pipeline, job, test), so re-running a
// recorder never double-counts. See docs/harness/flaky-ledger.md.
//
// Modes (all fail-soft: a ledger problem must never red a pipeline):
//   record-report <flaky-report.json> <ledger.jsonl>   tests that passed on retry
//   scan-retries  <ledger.jsonl>                       job-level retries, via the
//                                                      GitLab jobs API (env-driven)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { collectFlaky } from './check-flaky.mjs';

export const SCHEMA = 1;

const keyOf = (e) => [e.kind, e.sha, e.pipeline, e.job, e.test ?? ''].join('\u0000');

/** Parse a JSONL ledger, skipping blank or corrupt lines rather than throwing. */
export function parseLedger(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated line from an interrupted upload must not poison the ledger.
    }
  }
  return out;
}

/** Append `fresh` entries to `existing`, dropping any already present. */
export function mergeLedger(existing, fresh) {
  const seen = new Set(existing.map(keyOf));
  const added = [];
  for (const e of fresh) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(e);
  }
  return { merged: [...existing, ...added], added };
}

/** Ledger entries for every test in a Playwright JSON report that passed only on retry. */
export function entriesFromReport(report, ctx) {
  return collectFlaky(report).map((f) => ({
    schema: SCHEMA,
    kind: 'retry-pass',
    date: ctx.date,
    sha: ctx.sha,
    pipeline: ctx.pipeline,
    job: ctx.job,
    test: f.title,
    file: f.file,
  }));
}

/**
 * Find job names that have BOTH a failed and a success entry for the same sha.
 * That is a human clicking "retry" and the job going green — the strongest flake
 * signal available, and one a report-level check cannot see.
 *
 * @param {{name: string, status: string, pipeline?: {id: number, sha: string}}[]} jobs
 *   Jobs from `.../pipelines/:id/jobs?include_retried=true` across one or more pipelines.
 */
export function detectJobRetries(jobs, date) {
  const groups = new Map();
  for (const j of jobs) {
    const sha = j.pipeline?.sha ?? j.commit?.id;
    if (!sha) continue;
    const g = groups.get(`${sha}\u0000${j.name}`) ?? { sha, name: j.name, pipeline: j.pipeline?.id, statuses: new Set() };
    g.statuses.add(j.status);
    groups.set(`${sha}\u0000${j.name}`, g);
  }
  return [...groups.values()]
    .filter((g) => g.statuses.has('failed') && g.statuses.has('success'))
    .map((g) => ({ schema: SCHEMA, kind: 'job-retry', date, sha: g.sha, pipeline: g.pipeline ?? 0, job: g.name }));
}

function load(path) {
  return existsSync(path) ? parseLedger(readFileSync(path, 'utf-8')) : [];
}

function save(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

async function scanRetries(ledgerPath) {
  const { CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN } = process.env;
  const lookback = Number(process.env.FLAKY_LOOKBACK_PIPELINES ?? 20);
  if (!CI_API_V4_URL || !CI_PROJECT_ID || !CI_JOB_TOKEN) {
    console.log('flaky-ledger: not in CI — skipping scan-retries.');
    return;
  }
  const get = async (path) => {
    const res = await fetch(`${CI_API_V4_URL}/projects/${CI_PROJECT_ID}${path}`, {
      headers: { 'JOB-TOKEN': CI_JOB_TOKEN },
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  };
  const pipelines = await get(`/pipelines?ref=main&per_page=${lookback}`);
  const jobs = [];
  for (const p of pipelines) {
    const page = await get(`/pipelines/${p.id}/jobs?include_retried=true&per_page=100`);
    for (const j of page) jobs.push({ name: j.name, status: j.status, pipeline: { id: p.id, sha: p.sha } });
  }
  const fresh = detectJobRetries(jobs, new Date().toISOString().slice(0, 10));
  const { merged, added } = mergeLedger(load(ledgerPath), fresh);
  save(ledgerPath, merged);
  console.log(`flaky-ledger: ${added.length} new job-retry entr${added.length === 1 ? 'y' : 'ies'}; ledger has ${merged.length}.`);
  for (const e of added) console.warn(`  job-level retry: ${e.job} @ ${e.sha.slice(0, 8)} (pipeline ${e.pipeline})`);
}

function recordReport(reportPath, ledgerPath) {
  if (!existsSync(reportPath)) {
    console.log(`flaky-ledger: no report at ${reportPath} — nothing to record.`);
    return;
  }
  const ctx = {
    date: new Date().toISOString().slice(0, 10),
    sha: process.env.CI_COMMIT_SHA ?? 'local',
    pipeline: Number(process.env.CI_PIPELINE_ID ?? 0),
    job: process.env.CI_JOB_NAME ?? 'local',
  };
  const fresh = entriesFromReport(JSON.parse(readFileSync(reportPath, 'utf-8')), ctx);
  const { merged, added } = mergeLedger(load(ledgerPath), fresh);
  save(ledgerPath, merged);
  console.log(`flaky-ledger: recorded ${added.length} retry-pass entr${added.length === 1 ? 'y' : 'ies'}; ledger has ${merged.length}.`);
}

async function main(argv) {
  const [mode, a, b] = argv;
  try {
    if (mode === 'record-report') recordReport(a, b);
    else if (mode === 'scan-retries') await scanRetries(a);
    else console.error('usage: flaky-ledger.mjs record-report <report> <ledger> | scan-retries <ledger>');
  } catch (err) {
    console.warn(`flaky-ledger: ${err.message} — ledger not updated (non-fatal).`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // main() already turns every failure into a non-fatal warning; this rejection
  // handler only covers a throw from outside its try (it must still exit 0).
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (err) => {
      console.warn(`flaky-ledger: ${err?.message ?? err} — ledger not updated (non-fatal).`);
      process.exit(0);
    },
  );
}
