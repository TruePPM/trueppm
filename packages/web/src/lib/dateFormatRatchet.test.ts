/* global process */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Ratchet for the grandfathered date-formatting backlog (#4394). The eslint config
 * lists files under src/features that still hand-roll a date formatter and are exempt
 * from the guard. That list may only shrink: a file that no longer contains a raw call
 * must come off it (otherwise it is silently exempt forever), and the list may not grow.
 */
const WEB_ROOT = process.cwd();
const RAW = /toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat/;
const MAX_GRANDFATHERED = 23;

function grandfathered(): string[] {
  const cfg = readFileSync(resolve(WEB_ROOT, 'eslint.config.js'), 'utf8');
  const start = cfg.indexOf("files: ['src/features/**/*.{ts,tsx}'],\n    ignores: [");
  expect(start).toBeGreaterThan(-1);
  const block = cfg.slice(start, cfg.indexOf(']', start + 60));
  return [...block.matchAll(/'(src\/features\/[^']+\.tsx?)'/g)]
    .map((m) => m[1])
    .filter((f) => !f.includes('*'));
}

describe('date-format guard allowlist', () => {
  const files = grandfathered();

  it('never grows past the grandfathered count', () => {
    expect(files.length).toBeLessThanOrEqual(MAX_GRANDFATHERED);
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s still hand-rolls a formatter (else remove it from the list)', (f) => {
    expect(readFileSync(resolve(WEB_ROOT, f), 'utf8')).toMatch(RAW);
  });

  it('the guard rejects a reintroduced en-US toLocaleDateString in a feature file', async () => {
    // Lint a temporary on-disk probe, not `lintText` against an existing path:
    // type-aware parsing needs the file to exist in the TS project, and `lintText`
    // pointed at an existing feature file returned zero messages for every rule (the
    // guard looked dead on CI and locally, while a real file on disk fires it). A
    // unique name keeps parallel vitest workers from sharing the probe.
    const probe = resolve(
      WEB_ROOT,
      `src/features/auth/__dateGuardProbe_${process.pid}_${Date.now()}.ts`,
    );
    writeFileSync(probe, "export const f = (d: Date) => d.toLocaleDateString('en-US');\n");
    try {
      const eslint = new ESLint({ cwd: WEB_ROOT, cache: false });
      const [res] = await eslint.lintFiles([probe]);
      // Compare the rule ids as data so a failure prints what ESLint actually returned
      // (a parse error or an ignored-file warning reads very differently from a missing rule).
      expect(res.messages.map((m) => `${m.ruleId}: ${m.message.slice(0, 120)}`)).toEqual(
        expect.arrayContaining([expect.stringContaining('no-restricted-properties')]),
      );
    } finally {
      rmSync(probe, { force: true });
    }
    // A cold type-aware ESLint run (parser program build) costs 5+ s, which is the
    // default vitest timeout, so the timeout is explicit rather than left to race it.
  }, 60_000);
});
