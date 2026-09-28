import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Deletion guard for the authoritative-`hidden` rule (#4181, web rule 433).
 *
 * jsdom never loads Tailwind, so a component test's `not.toBeVisible()` on a
 * `hidden` body passes even when a `flex`/`grid` utility on the same element
 * paints it in a real browser — which is exactly how the sprint panel shipped
 * "collapsed" with its body open. The behavior is proven by
 * `e2e/today-board-above-fold.spec.ts`; this only stops the one global rule
 * that makes the attribute win from being quietly removed.
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/styles
const globals = readFileSync(resolve(here, 'globals.css'), 'utf8');

describe('[hidden] is authoritative over display utilities (#4181)', () => {
  it('forces display:none with !important so a utility cannot outrank it', () => {
    expect(globals).toMatch(
      /\[hidden\]:where\(:not\(\[hidden='until-found'\]\)\)\s*\{\s*display:\s*none\s*!important;\s*\}/,
    );
  });
});
