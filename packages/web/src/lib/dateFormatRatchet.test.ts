/* global process */
import { readFileSync } from 'node:fs';
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
const MAX_GRANDFATHERED = 24;

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
    // Probe a real, JSX-free .ts feature file: type-aware parsing needs a file in the
    // TS project, and probing a JSX-bearing .tsx made CI's react/no-unescaped-entities
    // visit that file's nodes against this one-line snippet's source lines and throw.
    const eslint = new ESLint({ cwd: WEB_ROOT, cache: false });
    const code = "export const f = (d: Date) => d.toLocaleDateString('en-US');\n";
    const [res] = await eslint.lintText(code, {
      filePath: resolve(WEB_ROOT, 'src/features/auth/ssoNext.ts'),
    });
    expect(res.messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
  });
});
