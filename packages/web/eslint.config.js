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
      // Prefer the Number.* static methods over the coercing global numeric
      // functions and bare NaN (#2099). Mirrors unicorn/prefer-number-properties
      // without pulling in the whole plugin — a core rule, so it guards product
      // and test files alike. Global isNaN/isFinite coerce their argument
      // (isNaN('12px') === true), whereas Number.isNaN('12px') === false; the
      // Number.* forms are stricter. parseInt/parseFloat differ only
      // stylistically. Infinity is
      // intentionally NOT restricted: it has many legitimate sentinel uses
      // (staleTime: Infinity, -Infinity fold seeds) that Number.POSITIVE_INFINITY
      // would only make noisier.
      'no-restricted-globals': [
        'error',
        { name: 'parseInt', message: 'Use Number.parseInt instead of the global.' },
        { name: 'parseFloat', message: 'Use Number.parseFloat instead of the global.' },
        {
          name: 'isNaN',
          message: 'Use Number.isNaN — it does not coerce its argument like the global isNaN.',
        },
        {
          name: 'isFinite',
          message: 'Use Number.isFinite — it does not coerce its argument like the global isFinite.',
        },
        { name: 'NaN', message: 'Use Number.NaN instead of the bare global.' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow _-prefixed params to signal intentionally unused arguments (e.g. stubs)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Catch dead initializers (`let x = init` where init is overwritten before
      // any read) — no-unused-vars misses these because the variable IS read
      // later. Mirrors CodeQL Code Quality's "initializer overwritten" finding so
      // it never reaches the GitHub mirror. Core rule, ships in eslint 9.
      'no-useless-assignment': 'error',
      // Ban `||` where the intent is "fall back when absent" on a value that can
      // legitimately BE zero (#2489). TruePPM has several meaning-carrying zeros —
      // `total_float === 0` is *on the critical path*, `duration === 0` is a
      // milestone, `percent_complete === 0` is not-started, `story_points === 0`
      // is explicitly estimated at zero — and `x || fallback` silently discards
      // every one of them. `??` only falls back on null/undefined.
      //
      // ignorePrimitives keeps string and boolean out of scope: `name || ''` and
      // `flag || false` are idiomatic, have no meaning-carrying falsy value worth
      // preserving, and converting them would be pure churn. Numbers are the whole
      // point of the rule here; `null`/`undefined` operands stay covered.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, boolean: true } },
      ],
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
  // Playwright tree (#2388). Every block above is scoped to `src/**`, so until
  // now `e2e/` matched no config at all and eslint skipped it outright ("file
  // ignored because no matching configuration was supplied") — ~230 specs with
  // no lint. #2382 brought them under `tsc`; this brings them under eslint.
  //
  // The rule that earns this block on its own is no-floating-promises: nearly
  // every Playwright call returns a promise, so a dropped `await` is not a type
  // error, it is a race that shows up later as an unreproducible flake. Type
  // information is what makes that rule possible, hence the type-checked preset
  // and the `project` pointing at tsconfig.e2e.json (the same project the
  // typecheck gate uses, so lint and tsc never disagree about what is in scope).
  {
    files: ['e2e/**/*.ts', 'playwright*.config.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.e2e.json',
      },
      globals: {
        // Specs run in Node (process.env, __dirname, Buffer) but also carry
        // browser code inside page.evaluate/addInitScript callbacks, which the
        // parser sees as ordinary function bodies in this file.
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs['recommended-type-checked'].rules,
      // Specs may not author `any` themselves — that stays an error, so the
      // three relaxations below can only ever admit `any` that arrived from a
      // library signature, never one a spec wrote.
      '@typescript-eslint/no-explicit-any': 'error',
      // The `any` these three rules fire on comes from exactly two library
      // signatures: Playwright's `Request.postDataJSON(): any` and the standard
      // `JSON.parse(): any`. Both appear in route handlers that assert on a
      // payload the same spec constructed a few lines earlier — the assertion is
      // the check, and `as Record<string, unknown>` at the boundary would only
      // restate the rule's own complaint without verifying anything.
      //
      // Cost of keeping them: 66 sites across 26 spec files, every fix a cast
      // or a narrowing chain over a request body the spec already knows the
      // shape of. That buys no defect detection and adds real churn to the
      // fixtures, so they are off here — and only here; `src/**` keeps the full
      // type-checked preset.
      //
      // no-unsafe-return and no-unsafe-call stay ON deliberately. Those are the
      // two that let `any` *escape*: a helper returning `any` infects every
      // caller, and calling an `any` value is an unchecked "is this even
      // callable". Both were cheap to fix (4 sites) and both are worth keeping.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-useless-assignment': 'error',
      // Same numeric-zero rationale as the src/** block above — a spec that
      // builds a fixture with `count || 5` hides a legitimate zero just as
      // readily as product code does.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, boolean: true } },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseInt', message: 'Use Number.parseInt instead of the global.' },
        { name: 'parseFloat', message: 'Use Number.parseFloat instead of the global.' },
        {
          name: 'isNaN',
          message: 'Use Number.isNaN — it does not coerce its argument like the global isNaN.',
        },
        {
          name: 'isFinite',
          message: 'Use Number.isFinite — it does not coerce its argument like the global isFinite.',
        },
        { name: 'NaN', message: 'Use Number.NaN instead of the bare global.' },
      ],
    },
  },
  // The default-export ban applies to the specs and fixtures, but NOT to the
  // playwright.*.config.ts files — Playwright loads a config by its default
  // export, so there is no named-export form available to them.
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT],
    },
  },
  prettierConfig,
];
