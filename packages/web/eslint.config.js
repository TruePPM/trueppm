import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

// Ban default exports — all modules use named exports. Shared so the
// iteration-label config block (which re-specifies no-restricted-syntax for the
// feature surfaces) keeps enforcing it too.
const NO_DEFAULT_EXPORT = {
  selector: 'ExportDefaultDeclaration',
  message: 'Default exports are not allowed. Use named exports instead.',
};

// Iteration-label gate (#1287, ADR-0111). User-facing copy on the
// sprint-container surfaces must read the project's configured label via
// useIterationLabel() (the `itl.*` forms), never the hard-coded word "sprint" —
// otherwise a team that renames its container to "Iteration", "PI", etc. sees
// stale "sprint" copy. These selectors flag the two highest-signal display
// positions with zero false positives from identifiers/comments/enum values:
// rendered JSX text and the display attributes (title/placeholder/alt/aria-label),
// matching both literal strings and template-literal quasis. Scoped below to the
// container feature dirs; settings methodology copy (which describes the agile
// concept, not this project's container) and cross-project "My Work" views (no
// single project to resolve a label from) are intentionally out of scope or
// exempted inline with an eslint-disable + reason. Object-prop/toast copy is a
// known gap — JSX text and a11y labels cover the common regression class.
const ITERATION_LABEL_MESSAGE =
  'Hard-coded "sprint" in user-facing copy. Use useIterationLabel() (the itl.* forms) so the label follows the project configuration (ADR-0111, #1287). If this text genuinely is not the iteration container, add `// eslint-disable-next-line no-restricted-syntax` with a reason.';
// The attribute selectors exclude a literal whose entire value is the bare word
// "sprint"/"sprints" (case-insensitive): that shape is always an enum/state token
// (e.g. `aria-label={step === 'sprint' ? … : …}`), never user-visible copy, which
// is always a phrase. JSXText needs no such guard — enum tokens never appear as
// rendered text. The trade-off is a standalone one-word "Sprint" attribute label
// is not caught; that is rare and acceptable next to the false-positive cost.
const ITERATION_LABEL_WORD_IN_PHRASE = '/^(?=.*\\bsprints?\\b)(?!sprints?$)/i';
const NO_HARDCODED_ITERATION_LABEL = [
  {
    selector: 'JSXText[value=/\\bsprints?\\b/i]',
    message: ITERATION_LABEL_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name=/^(title|placeholder|alt|aria-label)$/] Literal[value=${ITERATION_LABEL_WORD_IN_PHRASE}]`,
    message: ITERATION_LABEL_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name=/^(title|placeholder|alt|aria-label)$/] TemplateElement[value.raw=${ITERATION_LABEL_WORD_IN_PHRASE}]`,
    message: ITERATION_LABEL_MESSAGE,
  },
];

export default [
  {
    ignores: ['dist/', 'coverage/', 'src/api/types.ts', 'eslint.config.js', 'postcss.config.js'],
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
        ...globals.browser,
        // Vite compile-time constants injected via define in vite.config.ts
        __BUILD_SHA__: 'readonly',
        __APP_VERSION__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs['recommended-type-checked'].rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      // Enforce WCAG alt text at error level (not warn) — zero tolerance from day one
      'jsx-a11y/alt-text': 'error',
      // Ban default exports — all modules use named exports
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT],
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow _-prefixed params to signal intentionally unused arguments (e.g. stubs)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Catch dead initializers (`let x = init` where init is overwritten before
      // any read) — no-unused-vars misses these because the variable IS read
      // later. Mirrors CodeQL Code Quality's "initializer overwritten" finding so
      // it never reaches the GitHub mirror. Core rule, ships in eslint 9.
      'no-useless-assignment': 'error',
      // React 19: JSX transform does not require React in scope
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  // Iteration-label gate (#1287): enforce useIterationLabel() across the
  // sprint-container feature surfaces. A later config object re-specifies
  // no-restricted-syntax, so the default-export ban is included explicitly
  // (flat config replaces, not merges, a rule's options per matching file).
  {
    files: [
      'src/features/sprints/**/*.tsx',
      'src/features/board/**/*.tsx',
      'src/features/schedule/**/*.tsx',
      'src/features/project/backlog/**/*.tsx',
      'src/features/decisions/**/*.tsx',
    ],
    ignores: ['src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT, ...NO_HARDCODED_ITERATION_LABEL],
    },
  },
  // Test files also need vitest globals (describe, it, expect, etc.)
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  prettierConfig,
];
