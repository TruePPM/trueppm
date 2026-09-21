import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Pins the OAuth scopes `SsoProviderPanel.tsx` hardcodes for its Add-mode display
 * against the server-fixed constants they duplicate
 * (`services.OIDC_SCOPES` / `GITHUB_SCOPES`, ADR-0517 §3.4) — see #3951's "related
 * unpinned duplication" note and `contracts/sso-scopes.json`'s header. The pytest
 * counterpart is `test_server_fixed_scopes_match_the_contract` in
 * `packages/api/tests/apps/sso/test_sso_error_codes_contract.py`.
 *
 * Deliberately a NEW file, not an addition to `SsoProviderPanel.test.tsx` — another
 * agent is editing that file for #3950 — and deliberately does not import or edit
 * `SsoProviderPanel.tsx` itself (out of scope for #3951; #3950/#3947/#3949 own
 * that file's other regions). The scopes have no exported constant to import, so
 * this reads them out of the component's source text instead, the same
 * read-not-imported posture the JSON contract itself uses against both languages.
 */
function readErrorCodeContractRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error(
    'No checkout root (a directory containing .git) found above this spec — cannot ' +
      'locate contracts/sso-scopes.json (#3951).',
  );
}

function readScopesContract(): { oidc: string[]; github: string[] } {
  const root = readErrorCodeContractRoot();
  const contract = resolve(root, 'contracts/sso-scopes.json');
  if (!existsSync(contract)) {
    throw new Error(
      `Found the checkout root at ${root} but no contracts/sso-scopes.json in it ` +
        '— the SSO scopes contract is missing (#3951). If you just created it, ' +
        '`git add` it.',
    );
  }
  return JSON.parse(readFileSync(contract, 'utf-8')) as { oidc: string[]; github: string[] };
}

/**
 * Extracts the two hardcoded scope arrays from `SsoProviderPanel.tsx`'s source
 * text: `const scopes = existing?.scopes ?? (def.type === 'OAuth' ? [...] : [...]);`
 * This is intentionally coupled to that one line's shape — a fragile trade
 * accepted deliberately (design guidance, #3951) rather than exporting a constant
 * from a file this issue is fenced off from touching. If a refactor moves or
 * reformats the expression, this throws a clear "regex found nothing" error
 * instead of silently passing on stale extracted values.
 */
function readHardcodedPanelScopes(): { oidc: string[]; github: string[] } {
  const root = readErrorCodeContractRoot();
  const panelPath = resolve(
    root,
    'packages/web/src/features/settings/workspace/SsoProviderPanel.tsx',
  );
  const source = readFileSync(panelPath, 'utf-8');
  const match = source.match(/def\.type === 'OAuth' \? (\[[^\]]+\]) : (\[[^\]]+\])/);
  if (!match) {
    throw new Error(
      'Could not find the "def.type === \'OAuth\' ? [...] : [...]" scopes expression ' +
        'in SsoProviderPanel.tsx — it was likely reformatted or moved. Update the ' +
        'regex in ssoScopesContract.test.ts (#3951).',
    );
  }
  const toArray = (literal: string): string[] => JSON.parse(literal.replace(/'/g, '"')) as string[];
  return { github: toArray(match[1]), oidc: toArray(match[2]) };
}

describe('SsoProviderPanel.tsx hardcoded scopes vs. the server-fixed contract (#3951)', () => {
  it('the OAuth (GitHub) scopes match contracts/sso-scopes.json', () => {
    const contract = readScopesContract();
    const panel = readHardcodedPanelScopes();
    expect(panel.github).toEqual(contract.github);
  });

  it('the OIDC default scopes match contracts/sso-scopes.json', () => {
    const contract = readScopesContract();
    const panel = readHardcodedPanelScopes();
    expect(panel.oidc).toEqual(contract.oidc);
  });
});
