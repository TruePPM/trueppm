import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ERROR_COPY } from './SsoCompletePage';

/**
 * The web half of the SSO error-code cross-language contract (#3951). Its pytest
 * counterpart is `packages/api/tests/apps/sso/test_sso_error_codes_contract.py`,
 * which derives the backend's actual error-code set from
 * `services.OIDCError.__subclasses__()` plus the literal `error="..."` redirects
 * in `views.py`, and asserts it against the same JSON file this reads. Read off
 * disk rather than duplicated as a TS literal, so the file has exactly one
 * representation and neither language can "satisfy" the contract with its own copy.
 *
 * New test file, separate from `SsoCompletePage.test.tsx`, which covers the
 * rendered copy/behavior per code — this file only asserts the *set* of keys.
 */
function readErrorCodeContract(): { mapped: string[]; genericFallback: string[] } {
  // Anchored on a repo marker (`.git`), not merely on finding a `contracts/`
  // directory — see methodologyTabs.test.ts's identical helper (ADR-0942 §6) for
  // why an unanchored probe is the wrong failure mode here.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.git'))) {
      const contract = resolve(dir, 'contracts/sso-error-codes.json');
      if (!existsSync(contract)) {
        throw new Error(
          `Found the checkout root at ${dir} but no contracts/sso-error-codes.json ` +
            'in it — the SSO error-code contract is missing (#3951). If you just ' +
            'created it, `git add` it.',
        );
      }
      return JSON.parse(readFileSync(contract, 'utf-8')) as {
        mapped: string[];
        genericFallback: string[];
      };
    }
    dir = resolve(dir, '..');
  }
  throw new Error(
    'No checkout root (a directory containing .git) found above this spec — cannot ' +
      'locate contracts/sso-error-codes.json (#3951).',
  );
}

describe('ERROR_COPY vs. the checked-in backend error-code contract (#3951)', () => {
  it("has exactly the contract's `mapped` keys — no more, no fewer", () => {
    const contract = readErrorCodeContract();
    const actual = Object.keys(ERROR_COPY).sort();
    const expected = [...contract.mapped].sort();
    expect(actual).toEqual(expected);
  });

  it("does not map `oidc_error` — the contract's one intentional generic fallback", () => {
    // States the #3951 decision as a test, not just a comment: oidc_error is the
    // OIDCError base-class default and is documented as deliberately generic (see
    // the comment above ERROR_COPY in SsoCompletePage.tsx and
    // contracts/sso-error-codes.json's header) rather than silently unmapped.
    const contract = readErrorCodeContract();
    expect(contract.genericFallback).toEqual(['oidc_error']);
    expect(Object.keys(ERROR_COPY)).not.toContain('oidc_error');
  });

  it('gives every mapped code a non-empty title and subtitle (no placeholder copy)', () => {
    for (const [code, copy] of Object.entries(ERROR_COPY)) {
      expect(copy.title, `${code} title`).not.toBe('');
      expect(copy.subtitle, `${code} subtitle`).not.toBe('');
      expect(copy.code, `${code} code`).not.toBe('');
    }
  });
});
