// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #4984: in dark mode --semantic-critical is #F87171, and white on it is
// 2.77:1 (< 4.5:1, WCAG 1.4.3). Critical fills take `text-semantic-on-critical`,
// which flips to navy ink in dark mode.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));

describe('critical fill ink (#4984)', () => {
  it('no source pairs bg-semantic-critical with text-white', () => {
    const offenders: string[] = [];
    for (const f of walk(join(HERE, '..'))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Same quoted class string only: a sibling string on the line may
          // legitimately carry text-white on a neutral fill.
          const pair =
            /bg-semantic-critical(?![-/\w])[^'"`]*(?<![\w:-])text-white(?![\w-])/.test(line) ||
            /(?<![\w:-])text-white(?![\w-])[^'"`]*bg-semantic-critical(?![-/\w])/.test(line);
          if (
            pair &&
            !line.includes('dark:text-navy-900') &&
            !line.trim().startsWith('*') &&
            !line.trim().startsWith('//')
          ) {
            offenders.push(`${f}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('defines the on-critical token for both themes', () => {
    const css = readFileSync(join(HERE, 'globals.css'), 'utf8');
    expect(css.match(/--semantic-on-critical:/g)).toHaveLength(2);
  });
});
