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
      // Strip comments, then join `'a ' + 'b'` concatenations, so a class list
      // split across lines or string pieces is still one string. Known limit:
      // classes assembled from variables or ternary branches are not seen.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/(['"`])\s*\+\s*\1/g, '');
      for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\\])*)\1/g)) {
        const str = m[2];
        if (
          /bg-semantic-critical(?![-/\w])/.test(str) &&
          /(?<![\w:-])text-white(?![\w-])/.test(str)
        ) {
          offenders.push(`${f}: ${str.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('defines the on-critical token for both themes', () => {
    const css = readFileSync(join(HERE, 'globals.css'), 'utf8');
    expect(css.match(/--semantic-on-critical:/g)).toHaveLength(2);
  });
});
