import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

// Mirrors packages/web/eslint.config.js (named-exports-only, no-explicit-any,
// strict type-checked rules) adapted for React Native: React Native globals
// instead of browser globals, and no jsx-a11y plugin (no DOM a11y roles on
// native). The lint job is scoped to src/ exactly like web, so config files and
// metro/babel are out of scope.
//
// NOTE for #1599: there is no e2e/ tree today (#3367 deleted an un-runnable
// Detox scaffold). When one returns it will match NEITHER this config nor
// tsconfig.json, which is how the last one rotted unobserved — add an
// `e2e/**/*.ts` block against a tsconfig.e2e.json, as packages/web did, and keep
// @typescript-eslint/no-floating-promises on: an un-awaited Playwright/Detox
// call is not a type error, it is a race.
const NO_DEFAULT_EXPORT = {
  selector: 'ExportDefaultDeclaration',
  message: 'Default exports are not allowed. Use named exports instead.',
};

export default [
  {
    ignores: ['eslint.config.mjs', 'babel.config.js', 'metro.config.js', 'tailwind.config.js'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals['react-native'],
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs['recommended-type-checked'].rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      // Ban default exports — all modules use named exports.
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT],
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow _-prefixed params to signal intentionally unused arguments.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // RN + new JSX transform: React need not be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  prettierConfig,
];
