#!/usr/bin/env node
/**
 * Aggregate the e2e schema-guard observation log into a coverage report (#3440).
 *
 * The guard binds every mocked API response to `docs/api/openapi.json`, and the
 * only honest way to describe what that buys is a denominator: how many of the
 * schema's operations the mock layer actually touches, how many of those are
 * checked, and — the number that is easy to lose — how many are *unchecked for a
 * reason the guard cannot fix*, because the schema declares nothing for them.
 *
 * "The guard is installed" is not coverage. This script is what stops that
 * sentence from being mistaken for one.
 *
 * Usage:
 *   TRUEPPM_E2E_SCHEMA_GUARD=report \
 *   TRUEPPM_E2E_SCHEMA_REPORT=/tmp/schema.ndjson npx playwright test
 *   node scripts/e2e-schema-report.mjs /tmp/schema.ndjson [--waivers]
 *
 * `--waivers` prints a `schema-guard-waivers.ts` skeleton for everything still
 * violating, so the ledger is generated from measurement rather than typed from
 * memory. The reasons are still yours to write; a generated reason would be the
 * rubber stamp the ledger exists to avoid.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Collapse array indices so one ledger line covers every row of a list. */
function normalizeAt(at) {
  return (at || '<root>').replace(/\[\d+\]/g, '[]');
}

/**
 * Deterministic UTF-16 code-unit order — stable across engines and locales.
 * A plain node script cannot import the shared `src/lib/compareStrings.ts`
 * helper without a TS loader, so this mirrors it: the ledger and waiver
 * output below feed a generated TS source file, where the order needs to be
 * canonical for a stable diff, not locale-sensitive.
 */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function aggregate(ndjson) {
  const rows = ndjson
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const ok = new Set();
  const violating = new Set();
  const waived = new Set();
  const skipped = new Map(); // reason -> Set(operationKey)
  const ledger = new Map(); // operationKey -> Map(`at:rule` -> count)

  for (const row of rows) {
    if (row.outcome === 'ok') ok.add(row.operationKey);
    else if (row.outcome === 'waived') waived.add(row.operationKey);
    else if (row.outcome === 'skipped') {
      if (!skipped.has(row.reason)) skipped.set(row.reason, new Set());
      skipped.get(row.reason).add(row.operationKey);
    } else if (row.outcome === 'violation') {
      violating.add(row.operationKey);
      if (!ledger.has(row.operationKey)) ledger.set(row.operationKey, new Map());
      const entries = ledger.get(row.operationKey);
      (row.details ?? []).forEach((detail, index) => {
        const key = `${normalizeAt(detail.split(':')[0])}:${row.rules?.[index] ?? 'unknown'}`;
        entries.set(key, (entries.get(key) ?? 0) + 1);
      });
    }
  }

  return { rows, ok, violating, waived, skipped, ledger };
}

function render({ rows, ok, violating, waived, skipped, ledger }) {
  const touched = new Set([...ok, ...violating, ...waived]);
  for (const set of skipped.values()) for (const key of set) touched.add(key);
  const lines = [
    `responses observed        ${rows.length}`,
    `operations touched        ${touched.size}`,
    `  conforming              ${[...ok].filter((k) => !violating.has(k)).length} (never violated)`,
    `  partially conforming    ${[...ok].filter((k) => violating.has(k)).length}`,
    `  violating               ${violating.size}`,
    `  waived                  ${waived.size}`,
    '',
    'unchecked, and why:',
  ];
  for (const [reason, set] of [...skipped].sort((a, b) => b[1].size - a[1].size)) {
    lines.push(`  ${reason.padEnd(22)} ${set.size} operations`);
  }
  const ledgerLines = [...ledger.values()].reduce((n, m) => n + m.size, 0);
  lines.push('', `drift ledger lines        ${ledgerLines} across ${ledger.size} operations`);
  return lines.join('\n');
}

function renderWaivers({ ledger }) {
  const out = ['export const SCHEMA_GUARD_WAIVERS: Readonly<Record<string, SchemaGuardWaiver>> = {'];
  for (const [operationKey, entries] of [...ledger].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    out.push(`  '${operationKey}': {`);
    out.push(`    reason: 'TODO — why this is still served, and the issue that removes it',`);
    out.push(`    allow: [`);
    for (const key of [...entries.keys()].sort(compareCodeUnits)) out.push(`      '${key}',`);
    out.push(`    ],`);
    out.push(`  },`);
  }
  out.push('};');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/e2e-schema-report.mjs <observations.ndjson> [--waivers]');
    process.exit(2);
  }
  const result = aggregate(readFileSync(path, 'utf8'));
  console.log(process.argv.includes('--waivers') ? renderWaivers(result) : render(result));
}
