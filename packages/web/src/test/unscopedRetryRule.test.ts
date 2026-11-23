/**
 * Both-direction fixtures for the unscoped generic "Retry" button lint rule (#3516).
 *
 * Imports the exact `NO_UNSCOPED_RETRY_BUTTON` array from `eslint.config.js` (not a
 * copy), so a selector edit that stops matching fails here instead of going quiet.
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
const { NO_UNSCOPED_RETRY_BUTTON } = (await import(/* @vite-ignore */ configUrl)) as {
  NO_UNSCOPED_RETRY_BUTTON: RestrictedSyntaxEntry[];
};

const linter = new Linter();

function violations(
  code: string,
  selectors: RestrictedSyntaxEntry[] = NO_UNSCOPED_RETRY_BUTTON,
): number {
  const messages = linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      },
      rules: { 'no-restricted-syntax': ['error', ...selectors] },
    },
    'fixture.ts',
  );
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

const call = (name: string) => `page.getByRole('button', { name: ${name} });`;

describe('unscoped Retry button rule (#3516)', () => {
  it('negative control: with no selectors nothing is reported', () => {
    expect(violations(call("'Retry'"), [])).toBe(0);
  });

  it('has selectors to test', () => {
    expect(NO_UNSCOPED_RETRY_BUTTON.length).toBeGreaterThan(0);
  });

  describe('flags', () => {
    it.each([["'Retry'"], ['"Retry"'], ['/Retry/i'], ['/^Retry$/i'], ['/retry/'], ["'retry'"]])(
      'name: %s',
      (name) => {
        expect(violations(call(name))).toBe(1);
      },
    );

    it('name with exact: true', () => {
      expect(violations(`page.getByRole('button', { name: 'Retry', exact: true });`)).toBe(1);
    });
  });

  describe('does not flag', () => {
    it.each([['/Retry the refused change on X/'], ["'Retry sync'"], ["'Retry now'"]])(
      'specific name: %s',
      (name) => {
        expect(violations(call(name))).toBe(0);
      },
    );

    it('container-rooted chains', () => {
      expect(violations(`alert.getByRole('button', { name: 'Retry' });`)).toBe(0);
      expect(violations(`page.getByRole('alert').getByRole('button', { name: 'Retry' });`)).toBe(0);
    });
  });
});
