/**
 * Both-direction fixtures for the route-id lint rule (ADR-1237 §7).
 *
 * `:projectId` / `:programId` may be a key, not a UUID, so reading the raw param
 * and handing it to an API call sends a key to a UUID-typed endpoint — the ADR's
 * top risk #3. The rule (`NO_ROUTE_ID_FROM_PARAMS` in `eslint.config.js`, imported
 * here rather than copied) bans the three shapes that read it; the negative cases
 * pin that other params (`taskId`, `token`) and the approved hooks stay clean.
 */
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

interface RestrictedSyntaxEntry {
  selector: string;
  message: string;
}

const configUrl = pathToFileURL(resolve(process.cwd(), 'eslint.config.js')).href;
const { NO_ROUTE_ID_FROM_PARAMS } = (await import(/* @vite-ignore */ configUrl)) as {
  NO_ROUTE_ID_FROM_PARAMS: RestrictedSyntaxEntry[];
};

const linter = new Linter();

function violations(code: string): number {
  const messages = linter.verify(
    code,
    {
      files: ['**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      },
      rules: { 'no-restricted-syntax': ['error', ...NO_ROUTE_ID_FROM_PARAMS] },
    },
    'fixture.tsx',
  );
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('NO_ROUTE_ID_FROM_PARAMS', () => {
  it.each([
    ['destructured projectId', 'const { projectId } = useParams<{ projectId: string }>();'],
    ['destructured programId', 'const { programId } = useParams();'],
    ['renamed on destructure', 'const { projectId: id } = useParams();'],
    ['alongside another param', 'const { projectId, taskId } = useParams();'],
    ['member read off the call', 'const id = useParams().programId;'],
    ['the params two-step', 'const params = useParams(); const id = params.projectId;'],
  ])('reports %s', (_label, code) => {
    expect(violations(code)).toBe(1);
  });

  it.each([
    ['another param', 'const { taskId } = useParams<{ taskId: string }>();'],
    ['a share token', 'const { token } = useParams();'],
    ['the approved hook', 'const projectId = useProjectId();'],
    ['a generic params map', 'const params = useParams(); const v = params[key];'],
    ['an unrelated object', 'const { projectId } = props;'],
  ])('does not report %s', (_label, code) => {
    expect(violations(code)).toBe(0);
  });
});
