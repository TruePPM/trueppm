/**
 * Both-direction fixtures for the `flex-1 truncate` / `min-w-0` lint rule (rule 393, #3474).
 *
 * The rule itself lives in `eslint.config.js` as `NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0`;
 * this file imports that exact array — not a copy — so a selector edit that stops
 * matching fails here rather than going quiet in CI (rule 300(a)).
 *
 * That is not a hypothetical for this rule. Its first draft used the same lookahead
 * pattern *unanchored*, and esquery tests a selector regex with `RegExp.test`, which
 * retries at every offset: `"min-w-0 flex-1 truncate"` — the CORRECT form — matched
 * from the offset just past `min-w-0`, where the negative lookahead sees no remaining
 * `min-w-0`. The rule reported 43 sites against `origin/main` where 26 exist, and 17
 * of them were already-fixed elements. The class-order permutations below are the
 * regression fixtures for that; a rule that reports a fixed site is how a gate gets
 * turned off, which costs more than the class it was catching.
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

// Dynamic import for the same reason as the sibling rule test: `eslint.config.js`
// sits outside `src/` (and outside tsconfig's include), so a static import would not
// resolve under `tsc --noEmit`.
const configUrl = pathToFileURL(resolve(process.cwd(), 'eslint.config.js')).href;
const { NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0 } = (await import(/* @vite-ignore */ configUrl)) as {
  NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0: RestrictedSyntaxEntry[];
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
      rules: { 'no-restricted-syntax': ['error', ...NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0] },
    },
    'fixture.tsx',
  );
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('flex-1 truncate without min-w-0 rule (rule 393)', () => {
  it('has selectors to test', () => {
    // Guards the import itself: an empty array would make every "reports nothing"
    // case below pass vacuously.
    expect(NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0.length).toBeGreaterThan(0);
  });

  describe('reports a violation', () => {
    it('a plain string className (ProgramProjectsPage shape)', () => {
      expect(
        violations(
          `export const A = () => (
            <span className="flex-1 truncate text-sm font-medium" />
          );`,
        ),
      ).toBe(1);
    });

    it('the reversed class order (CapacityPreflight shape)', () => {
      expect(violations(`export const B = () => <span className="truncate flex-1" />;`)).toBe(1);
    });

    it('a className wrapped across lines — the shape a line-oriented grep cannot see', () => {
      expect(
        violations(
          `export const C = () => (
            <a className="flex-1
                 truncate text-sm
                 hover:text-brand-primary" />
          );`,
        ),
      ).toBe(1);
    });

    it('a template-literal className', () => {
      expect(
        violations('export const D = () => <span className={`flex-1 truncate ${tone}`} />;'),
      ).toBe(1);
    });
  });

  describe('reports nothing', () => {
    // The three permutations below are the anchoring regression (see the file
    // header). Each one is a correctly-fixed element, and the unanchored draft
    // reported the first two.
    it('min-w-0 BEFORE flex-1', () => {
      expect(
        violations(`export const E = () => <span className="min-w-0 flex-1 truncate" />;`),
      ).toBe(0);
    });

    it('min-w-0 BEFORE both classes, with the reversed order', () => {
      expect(
        violations(`export const F = () => <span className="min-w-0 truncate flex-1" />;`),
      ).toBe(0);
    });

    it('min-w-0 between the two classes', () => {
      expect(
        violations(`export const G = () => <span className="flex-1 min-w-0 truncate" />;`),
      ).toBe(0);
    });

    it('min-w-0 on a later wrapped line', () => {
      expect(
        violations(
          `export const H = () => (
            <span className="flex-1 truncate text-sm
                 min-w-0 hover:text-brand-primary" />
          );`,
        ),
      ).toBe(0);
    });

    it('flex-1 with no truncate — nothing to collapse', () => {
      expect(violations(`export const I = () => <span className="flex-1 text-sm" />;`)).toBe(0);
    });

    it('truncate with no flex-1 — not a flex child, min-width:auto does not apply', () => {
      expect(violations(`export const J = () => <span className="truncate text-sm" />;`)).toBe(0);
    });

    it('the same string in an attribute that is not className', () => {
      expect(violations(`export const K = () => <span title="flex-1 truncate" />;`)).toBe(0);
    });

    it('the CONTAINER shape — deliberately out of scope, and the gap that matters most', () => {
      // `flex-1` on a container whose truncating text is a descendant IS the
      // shape that overflows a row (measured in Chromium: 307px inside a 300px
      // row, 187px of overflow, fixed to 120px/0px by `min-w-0`). This rule does
      // not report it, and 18 unreviewed sites in this tree carry it — see
      // rule 393. Pinned as a fixture so the exemption is a recorded decision
      // rather than something a future reader has to discover by testing.
      expect(
        violations(
          `export const Q = () => (
            <div className="flex-1">
              <span className="truncate">{name}</span>
            </div>
          );`,
        ),
      ).toBe(0);
    });

    it('a class that merely contains the substrings', () => {
      // `flex-1` is matched on word boundaries, so `basis-1`/`flex-none` and a
      // `truncated` identifier must not trip it.
      expect(
        violations(`export const L = () => <span className="flex-none basis-1 truncated" />;`),
      ).toBe(0);
    });
  });
});
