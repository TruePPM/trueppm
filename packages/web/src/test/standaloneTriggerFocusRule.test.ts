/**
 * Both-direction fixtures for the standalone-trigger focus-ring lint rule (#2858).
 *
 * The rule itself lives in `eslint.config.js` as `NO_FOCUS_VISIBLE_ON_TRIGGER`; this
 * file imports that exact array — not a copy — so a selector edit that stops matching
 * fails here rather than going quiet in CI. That failure mode is the whole reason this
 * test exists: the mechanism it replaces (`e2e/focus-ring-pointer.spec.ts`, #2292)
 * asserted on two hardcoded controls, so seven new violations landed inside trees
 * #2042/#2166 had already swept while every gate stayed green. A sweep that can silently
 * match nothing is indistinguishable from a clean tree.
 *
 * Each case is a minimal .tsx source linted through eslint's flat `Linter` with the
 * TypeScript parser. Type-aware rules are deliberately absent — this asserts the
 * selector's reach, not the project's full lint config.
 */
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Explicit import rather than the ambient global: the eslint config gives `src/**`
// browser globals only, so a bare `process` is a `no-undef` error here.
import process from 'node:process';

interface RestrictedSyntaxEntry {
  selector: string;
  message: string;
}

// Dynamic import: `eslint.config.js` sits outside `src/` (and outside tsconfig's
// include), so a static import would not resolve under `tsc --noEmit`. Resolving it
// at runtime keeps the test bound to the real rule definition without teaching the
// TypeScript project about the config file. Resolved from `process.cwd()` (the
// package root vitest runs in) rather than `import.meta.url`, which under the jsdom
// environment is an http: URL the ESM loader refuses.
const configUrl = pathToFileURL(resolve(process.cwd(), 'eslint.config.js')).href;
const { NO_FOCUS_VISIBLE_ON_TRIGGER } = (await import(/* @vite-ignore */ configUrl)) as {
  NO_FOCUS_VISIBLE_ON_TRIGGER: RestrictedSyntaxEntry[];
};

const linter = new Linter();

/** Count rule reports for one .tsx source. */
function violations(code: string): number {
  const messages = linter.verify(
    code,
    {
      files: ['**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      },
      rules: { 'no-restricted-syntax': ['error', ...NO_FOCUS_VISIBLE_ON_TRIGGER] },
    },
    'fixture.tsx',
  );
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('standalone-trigger focus-ring rule (rules 4/214)', () => {
  it('has selectors to test', () => {
    // Guards the import itself: an empty array would make every "must not report"
    // case below pass vacuously.
    expect(NO_FOCUS_VISIBLE_ON_TRIGGER.length).toBeGreaterThan(0);
  });

  describe('reports a violation', () => {
    it('aria-expanded disclosure with a string className (FlowAnalyticsPanel shape)', () => {
      expect(
        violations(
          `export const A = () => (
            <button type="button" aria-expanded={open} aria-controls="b"
              className="px-3 focus-visible:ring-2 focus-visible:ring-brand-primary" />
          );`,
        ),
      ).toBe(1);
    });

    it('aria-haspopup menu trigger with a template-literal className (BurnChartChrome shape)', () => {
      expect(
        violations(
          `export const B = () => (
            <button type="button" aria-haspopup="menu"
              className={\`h-8 \${tone} focus-visible:outline-none focus-visible:ring-2\`} />
          );`,
        ),
      ).toBe(1);
    });

    it('className assembled from an array/join of string literals (SprintScopeBadge shape)', () => {
      expect(
        violations(
          `export const C = () => (
            <button type="button" aria-expanded={x}
              className={[base, 'focus-visible:ring-2 focus-visible:ring-brand-primary'].join(' ')} />
          );`,
        ),
      ).toBe(1);
    });
  });

  describe('reports nothing', () => {
    it('a standalone trigger already converted to focus:', () => {
      expect(
        violations(
          `export const D = () => (
            <button type="button" aria-expanded={open}
              className="focus:outline-none focus:ring-2 focus:ring-brand-primary" />
          );`,
        ),
      ).toBe(0);
    });

    it('a form field that carries aria-expanded — rule 4 keeps combobox inputs on focus-visible:', () => {
      expect(
        violations(
          `export const E = () => (
            <input role="combobox" aria-expanded={open}
              className="focus-visible:outline-none focus-visible:ring-2" />
          );`,
        ),
      ).toBe(0);
    });

    it('a plain button with no disclosure/menu semantics', () => {
      expect(
        violations(
          `export const F = () => (
            <button type="button" className="focus-visible:ring-2 focus-visible:ring-brand-primary" />
          );`,
        ),
      ).toBe(0);
    });

    it('focus-visible: on a child of the trigger, not on the trigger itself', () => {
      expect(
        violations(
          `export const G = () => (
            <button type="button" aria-expanded={open} className="focus:ring-2">
              <span className="focus-visible:ring-2" />
            </button>
          );`,
        ),
      ).toBe(0);
    });
  });
});
