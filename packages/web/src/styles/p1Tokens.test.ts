import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 1.4.3 guard for the shell v2 semantic token family (`--p1-*`).
 *
 * The family is authored in OKLCH, which `tokenContrast.test.ts` cannot read
 * (it parses `R G B` integer triples), so this test carries its own
 * OKLCH → linear-sRGB conversion and asserts the exact pairings the token
 * block in globals.css promises. Pin the contract here, not in prose: a
 * future lightness tweak to `--p1-text-3` or a tint fails loud instead of
 * shipping a sub-AA label.
 *
 * Colors are measured as rendered: a token with baked-in alpha (the dark
 * tints) is composited over the surface it is documented to sit on before
 * the ratio is computed, so the assertion is about pixels, not about a raw
 * translucent value that no user ever sees.
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/styles
const globals = readFileSync(resolve(here, 'globals.css'), 'utf8');
const tailwind = readFileSync(resolve(here, '../../tailwind.config.ts'), 'utf8');

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3;

type Oklch = { l: number; c: number; h: number; a: number };

/** Parses every `--p1-<name>: L C H;` or `--p1-<name>: oklch(L C H [/ A]);` in a scope body. */
function parseP1Block(body: string): Record<string, Oklch> {
  const out: Record<string, Oklch> = {};
  const triple = /--p1-([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*;/g;
  const func =
    /--p1-([a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = triple.exec(body)) !== null) {
    out[m[1]] = { l: Number(m[2]), c: Number(m[3]), h: Number(m[4]), a: 1 };
  }
  while ((m = func.exec(body)) !== null) {
    out[m[1]] = {
      l: Number(m[2]),
      c: Number(m[3]),
      h: Number(m[4]),
      a: m[5] === undefined ? 1 : Number(m[5]),
    };
  }
  return out;
}

/** Returns the body of the first `<selector> { … }` scope AFTER `marker` in the file. */
function scopeAfter(marker: string, selector: RegExp): string {
  const start = globals.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const rest = globals.slice(start);
  const m = selector.exec(rest);
  if (!m || m.index === undefined)
    throw new Error(`selector not found after marker: ${String(selector)}`);
  const open = rest.indexOf('{', m.index);
  const close = rest.indexOf('}', open);
  return rest.slice(open + 1, close);
}

const MARKER = 'Shell v2 semantic tokens (Pass 1 redesign)';
const light = parseP1Block(scopeAfter(MARKER, /:root,\s*\.theme-light\s*\{/));
const dark = parseP1Block(scopeAfter(MARKER, /\.dark\s*\{/));

/** OKLCH → linear sRGB (D65), per CSS Color 4 §Oklab. Returns [r, g, b] in linear light, unclamped. */
function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return [
    +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Alpha-composites `fg` over an opaque `bg` in linear light; returns opaque linear RGB. */
function over(fg: Oklch, bg: Oklch): [number, number, number] {
  const f = oklchToLinearSrgb(fg).map(clamp01);
  const g = oklchToLinearSrgb(bg).map(clamp01);
  return [0, 1, 2].map((i) => f[i] * fg.a + g[i] * (1 - fg.a)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(lf: number, lb: number): number {
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast of `fg` (possibly translucent) rendered on opaque `bg`. */
function contrast(fg: Oklch, bg: Oklch): number {
  const lb = luminance(oklchToLinearSrgb(bg).map(clamp01) as [number, number, number]);
  return ratio(luminance(over(fg, bg)), lb);
}

/**
 * WCAG contrast of opaque `text` on a chip whose `tint` (possibly translucent)
 * is itself composited over `sheet` — i.e. the pixels a status chip renders.
 */
function contrastOnTint(text: Oklch, tint: Oklch, sheet: Oklch): number {
  const chipBg = over(tint, sheet);
  const fg = oklchToLinearSrgb(text).map(clamp01) as [number, number, number];
  return ratio(luminance(fg), luminance(chipBg));
}

const TEXT = ['text-1', 'text-2', 'text-3'] as const;
const SURFACES = ['surface-0', 'surface-1', 'surface-2'] as const;
const STATUS_TEXT = ['critical', 'risk-text', 'ok', 'info'] as const;

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('shell v2 tokens — %s theme', (theme, tokens) => {
  it('defines the full family', () => {
    for (const name of [
      ...SURFACES,
      'surface-3',
      ...TEXT,
      'brand',
      'brand-hover',
      'brand-tint',
      'on-brand',
      'critical',
      'critical-tint',
      'risk',
      'risk-text',
      'risk-tint',
      'ok',
      'ok-tint',
      'info',
      'info-tint',
      'over-1',
      'over-2',
      'on-over',
      'focus',
    ]) {
      expect(tokens[name], `${theme}: --p1-${name} missing`).toBeDefined();
    }
  });

  it.each(TEXT.flatMap((t) => SURFACES.map((s) => [t, s] as const)))(
    '%s clears 4.5:1 on %s',
    (text, surface) => {
      expect(contrast(tokens[text], tokens[surface])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );

  it.each(STATUS_TEXT)('%s clears 4.5:1 as text on surface-1', (name) => {
    expect(contrast(tokens[name], tokens['surface-1'])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('on-brand clears 4.5:1 on brand and brand-hover', () => {
    expect(contrast(tokens['on-brand'], tokens.brand)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(tokens['on-brand'], tokens['brand-hover'])).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  it('on-over clears 4.5:1 on both over-allocation fills', () => {
    expect(contrast(tokens['on-over'], tokens['over-1'])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(tokens['on-over'], tokens['over-2'])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('status text stays AA on its own tint (chips composite the tint over surface-1)', () => {
    const s1 = tokens['surface-1'];
    const onTint = (text: string, tint: string) => contrastOnTint(tokens[text], tokens[tint], s1);
    expect(onTint('critical', 'critical-tint')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(onTint('risk-text', 'risk-tint')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(onTint('ok', 'ok-tint')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(onTint('info', 'info-tint')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('focus ring clears 3:1 against the sheet (WCAG 1.4.11)', () => {
    expect(contrast(tokens.focus, tokens['surface-1'])).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('surfaces step monotonically in lightness so depth reads without shadows', () => {
    const l = (n: string) => tokens[n].l;
    if (theme === 'light') {
      expect(l('surface-1')).toBeGreaterThan(l('surface-0'));
      expect(l('surface-0')).toBeGreaterThan(l('surface-2'));
      expect(l('surface-2')).toBeGreaterThan(l('surface-3'));
    } else {
      expect(l('surface-0')).toBeLessThan(l('surface-1'));
      expect(l('surface-1')).toBeLessThan(l('surface-2'));
      expect(l('surface-2')).toBeLessThan(l('surface-3'));
    }
  });
});

describe('shell v2 tokens — Tailwind wiring', () => {
  it('exposes every --p1 token under the p1 namespace with the alpha-modifier form for opaque colors', () => {
    for (const name of [
      'surface-0',
      'surface-1',
      'text-1',
      'text-2',
      'brand',
      'critical',
      'risk-text',
      'ok',
      'info',
      'over-2',
      'focus',
    ]) {
      expect(tailwind).toContain(`oklch(var(--p1-${name}) / <alpha-value>)`);
    }
    for (const name of ['brand-tint', 'critical-tint', 'risk-tint', 'ok-tint', 'info-tint']) {
      expect(tailwind).toContain(`var(--p1-${name})`);
    }
  });

  it('derives hairlines and load steps from text-1 so they track the active theme', () => {
    expect(tailwind).toContain("hairline:         'oklch(var(--p1-text-1) / 0.10)'");
    expect(tailwind).toContain("'load-4':         'oklch(var(--p1-text-1) / 0.34)'");
  });
});
