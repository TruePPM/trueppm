import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Design System v2 golden-token guard (ADR-0126). Locks the warm-paper
 * reconciliation and the canonical v2 aliases so a future edit can't silently
 * regress the app back to cool grey / white or drop the v2 token contract.
 * Reads the real source files (vitest cwd = packages/web).
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/styles
const globals = readFileSync(resolve(here, 'globals.css'), 'utf8');
const tailwind = readFileSync(resolve(here, '../../tailwind.config.ts'), 'utf8');

describe('design-system v2 tokens (ADR-0126)', () => {
  it('defines the warm-paper canvas in both light and dark scopes', () => {
    // light canvas = #F2EEE5 (paper-2); dark canvas = #0E1626 (paper)
    expect(globals).toMatch(/--app-canvas:\s*242 238 229/);
    expect(globals).toMatch(/--app-canvas:\s*14 22 38/);
  });

  it('warms the light neutral surfaces off cool grey', () => {
    // sunken warmed from cool #EBEBEB (235 235 235) to paper-3 #EAE5D9
    expect(globals).toMatch(/--neutral-surface-sunken:\s*234 229 217/);
    // border warmed to line #E6E1D6
    expect(globals).toMatch(/--neutral-border:\s*230 225 214/);
    // the old cool greys must be gone
    expect(globals).not.toMatch(/--neutral-surface-sunken:\s*235 235 235/);
  });

  it('routes the body background to the warm canvas, not white surface', () => {
    expect(globals).toMatch(/background-color:\s*rgb\(var\(--app-canvas\)\)/);
  });

  it('exposes the canonical v2 golden aliases (light + dark)', () => {
    expect(globals).toMatch(/--paper:\s*#FAF8F3/);
    expect(globals).toMatch(/--ink:\s*#1B2A4A/);
    // sage FILL identity per ADR-0126 §3 (text still uses brand-primary sage-700)
    expect(globals).toMatch(/--sage:\s*#3E8C6D/);
    expect(globals).toMatch(/--paper:\s*#0E1626/); // dark scope
  });

  it('keeps the AA-safe sage-700 brand-primary text token (ADR-0126 §3)', () => {
    expect(globals).toMatch(/--brand-primary:\s*49 111 87/); // sage-700 #316F57
  });

  it('exposes the v2 tokens through Tailwind', () => {
    expect(tailwind).toMatch(/'app-canvas':\s*'rgb\(var\(--app-canvas\)/);
    expect(tailwind).toMatch(/card:\s*'12px'/);
    expect(tailwind).toMatch(/control:\s*'8px'/);
    expect(tailwind).toMatch(/chip:\s*'6px'/);
    expect(tailwind).toMatch(/boxShadow:/);
  });
});
