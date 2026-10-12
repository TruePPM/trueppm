import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 1.4.3 token-contrast guard (issue #4379). `--neutral-text-disabled`
 * shipped at 2.70:1 light / 3.33:1 dark — below the 4.5:1 AA floor for normal
 * text — while being used as an informational/muted-text color in 156
 * component files, not only on genuinely disabled controls (which WCAG 1.4.3
 * exempts). This test parses the real `:root, .theme-light` and `.dark`
 * token blocks out of globals.css and asserts every "text-on-surface" token
 * pairing clears 4.5:1 in both themes, so a future token edit (or a revert of
 * this one) fails loud instead of shipping a silent sub-AA regression.
 *
 * Deliberately NOT covered here (different WCAG clauses, different math):
 *   - `--input-border` / `--chart-neutral` / `--neutral-border` — these are
 *     non-text boundary/mark tokens governed by the ≥3:1 WCAG 1.4.11 floor,
 *     not the ≥4.5:1 1.4.3 text floor (see the #2207 comment in globals.css).
 *   - `--neutral-text-inverse` — only ever composited on filled/brand
 *     backgrounds (buttons, badges, the sage/navy fills), never against a
 *     `--neutral-surface*`/`--app-canvas` token, so testing it against the
 *     neutral surface set would assert a pairing the app never renders.
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/styles
const globalsPath = resolve(here, 'globals.css');
const globals = readFileSync(globalsPath, 'utf8');

const AA_NORMAL_TEXT_RATIO = 4.5;

/**
 * Tokens only legal on genuinely inert/disabled controls, where WCAG 1.4.3's
 * "inactive user interface component" exemption applies and a sub-4.5:1
 * color is an intentional, allowed "you can't use this" signal rather than a
 * bug. Empty today: #4379 darkened `--neutral-text-disabled` itself to clear
 * 4.5:1 everywhere (it is used for informational text, not disabled-only, in
 * 156 files), so no token currently needs the exemption. Kept as a named,
 * commented mechanism rather than deleted, so a genuinely disabled-only token
 * added later has a documented place to be exempted instead of someone
 * loosening AA_NORMAL_TEXT_RATIO or deleting an assertion to make it pass.
 */
const DISABLED_ONLY_ALLOWLIST: ReadonlySet<string> = new Set([
  // 'token-name': 'reason + issue link',
]);

interface TokenBlock {
  [token: string]: [number, number, number];
}

/** Parses `--token: R G B;` triples out of one `{ ... }` scope body. */
function parseTokenBlock(body: string): TokenBlock {
  const tokens: TokenBlock = {};
  const re = /--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const [, name, r, g, b] = m;
    tokens[name] = [Number(r), Number(g), Number(b)];
  }
  return tokens;
}

/** Extracts the body of the FIRST `<selector> {`-matched block (non-nested CSS, one level). */
function extractBlock(css: string, selectorRe: RegExp): string {
  const idx = css.search(selectorRe);
  if (idx === -1) {
    throw new Error(`Could not find selector ${selectorRe} in globals.css`);
  }
  const openBrace = css.indexOf('{', idx);
  let depth = 0;
  let i = openBrace;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(openBrace + 1, i);
}

// `:root,\n  .theme-light {` is the light token block; `.dark {` right after it.
const lightBody = extractBlock(globals, /:root,\s*\n\s*\.theme-light\s*\{/);
const darkBody = extractBlock(globals, /\n\s*\.dark\s*\{/);

const lightTokens = parseTokenBlock(lightBody);
const darkTokens = parseTokenBlock(darkBody);

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

// Text tokens that render as normal body/informational text directly on a
// neutral surface or the app canvas (WCAG 1.4.3's "normal text" category).
const TEXT_TOKENS = ['neutral-text-primary', 'neutral-text-secondary', 'neutral-text-disabled'];

// Every surface a text token can be read against in practice.
const SURFACE_TOKENS = [
  'app-canvas',
  'neutral-surface',
  'neutral-surface-raised',
  'neutral-surface-sunken',
];

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
])('token contrast — %s theme (WCAG 1.4.3, ≥4.5:1)', (_themeName, tokens) => {
  for (const textToken of TEXT_TOKENS) {
    if (DISABLED_ONLY_ALLOWLIST.has(textToken)) {
      it.skip(`${textToken} — allowlisted disabled-only token`, () => {});
      continue;
    }
    for (const surfaceToken of SURFACE_TOKENS) {
      it(`--${textToken} on --${surfaceToken} clears 4.5:1`, () => {
        const text = tokens[textToken];
        const surface = tokens[surfaceToken];
        expect(text, `--${textToken} not found in parsed token block`).toBeDefined();
        expect(surface, `--${surfaceToken} not found in parsed token block`).toBeDefined();

        const ratio = contrastRatio(text, surface);
        expect(
          ratio,
          `--${textToken} ${toHex(text)} on --${surfaceToken} ${toHex(surface)} is ` +
            `${ratio.toFixed(2)}:1, below the ${AA_NORMAL_TEXT_RATIO}:1 WCAG 1.4.3 floor`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
      });
    }
  }
});

describe('token-contrast guard negative control', () => {
  it('fails a token that is actually below 4.5:1 (proves the assertion is live, not vacuous)', () => {
    const belowAA: [number, number, number] = [160, 157, 153]; // old --neutral-text-disabled #A09D99
    const white: [number, number, number] = [255, 255, 255];
    const ratio = contrastRatio(belowAA, white);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT_RATIO);
    expect(ratio).toBeCloseTo(2.7, 1);
  });
});
