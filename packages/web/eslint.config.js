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

// Ban page-level `page.getByRole('combobox')` in specs (#2778). The ⌘K palette is
// only one of several comboboxes the app renders — BurnChart's `<select
// aria-label="Metric">`, LocationSegment, and EntitySelectCombobox are the others —
// so an unscoped query matches whichever happen to be mounted. That produced two
// failure modes on one main pipeline: a strict-mode violation (two matches, throws)
// and, worse, a *silent false pass* where `.or(getByRole('textbox')).first()` resolved
// to the BurnChart select and asserted `toHaveValue('?')` against it, reading back
// "tasks". Reach the palette via the `paletteSearch`/`openCommandPalette` fixtures,
// which scope to the dialog; scope any other combobox to its own container.
//
// `arguments.length=1` is load-bearing: it flags only the bare form. The named form
// `page.getByRole('combobox', { name: 'Estimation scale' })` is already unambiguous —
// the accessible name is the scope — and 20 legitimate sites use it. Flagging those
// would be noise that gets the whole rule disabled.
const NO_UNSCOPED_COMBOBOX = {
  selector:
    "CallExpression[callee.object.name='page'][callee.property.name='getByRole'][arguments.length=1] > Literal[value='combobox']",
  message:
    "Unscoped page.getByRole('combobox') matches any combobox on the page (#2778). " +
    "For the ⌘K palette use paletteSearch(page) from './fixtures'; otherwise scope to " +
    "the containing dialog/row locator, or name it: getByRole('combobox', { name: … }).",
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

// Standalone-trigger focus-ring gate (rules 4/214, #2858). Firefox, desktop
// Safari AND Chromium all decline to match `:focus-visible` when a `<button>` is
// focused by a *mouse click*, so a disclosure/menu trigger styled
// `focus-visible:ring-*` paints NO ring at all after a click — a WCAG 2.4.7
// failure. Rule 4's carve-out is therefore: standalone triggers use `focus:`;
// form fields (which browsers always match `:focus-visible` on) keep
// `focus-visible:`.
//
// This selector is the *tree sweep* that the check has been missing. It replaces
// nothing — `e2e/focus-ring-pointer.spec.ts` still proves WHY the rule exists
// (the browser behavior pair), but it only ever exercised two hardcoded controls
// (#2292), so the same seven violations landed inside trees #2042/#2166 had
// already converted. A behavioral spec cannot sweep: it can only assert on the
// controls whose routes it happens to visit. An AST sweep can, and does.
//
// Scope decisions, each of which is what keeps the rule at zero false positives:
//   · `JSXOpeningElement[name.name="button"]` — a lowercase intrinsic `<button>`
//     only. A custom `<Trigger>` component's ring lives in the component, which
//     this rule reaches there instead of at every call site.
//   · `:has(JSXAttribute[name.name=/^aria-(haspopup|expanded)$/])` — the two
//     attributes that *define* a disclosure/menu/popover trigger. This is why
//     `<input role="combobox" aria-expanded>` and friends are not caught: they
//     are form fields, and rule 4 keeps them on `focus-visible:` deliberately.
//   · the descendant match covers a plain string className, a template literal,
//     and the string arguments of a `cn(...)`/ternary — every form the codebase
//     actually writes.
//
// Known gap (accepted): a className assembled from an imported constant (e.g.
// `FOCUS_RING` in features/programs/backlog/styles.ts) is invisible here, because
// the string is not lexically inside the opening element. Rule 214 already calls
// that constant out by name.
//
// `features/schedule/` is exempted by a later config object — the Schedule tree
// stays `focus-visible:` deliberately per rule 137, which rule 4 restates.
const FOCUS_TRIGGER_MESSAGE =
  'A standalone trigger (`<button>` with aria-haspopup/aria-expanded) must use `focus:ring-*`, not `focus-visible:ring-*` (rules 4/214). Firefox, desktop Safari and Chromium do not match :focus-visible on a pointer-initiated button focus, so this control shows no focus ring at all after a mouse click (WCAG 2.4.7). Write `focus:outline-none focus:ring-2 focus:ring-brand-primary` plus `focus:ring-offset-1` (freestanding) or `focus:ring-inset` (menu rows). Form fields keep `focus-visible:`.';
const STANDALONE_TRIGGER =
  'JSXOpeningElement[name.name="button"]:has(JSXAttribute[name.name=/^aria-(haspopup|expanded)$/])';
export const NO_FOCUS_VISIBLE_ON_TRIGGER = [
  {
    selector: `${STANDALONE_TRIGGER} Literal[value=/focus-visible:/]`,
    message: FOCUS_TRIGGER_MESSAGE,
  },
  {
    selector: `${STANDALONE_TRIGGER} TemplateElement[value.raw=/focus-visible:/]`,
    message: FOCUS_TRIGGER_MESSAGE,
  },
];

// A shrinkable `flex-1` box that holds truncating text (rule 393, #3474).
//
// A flex item's `min-width` computes to `auto`, which resolves to its CONTENT
// minimum — so the item refuses to shrink below the intrinsic width of its text,
// pushes its siblings out, and overflows the row. `min-w-0` restores the
// shrinkable floor that makes an ellipsis possible.
//
// **Be precise about which shape that actually bites, because #3474 was filed
// against the wrong one.** CSS Sizing 3 §5.2 zeroes the automatic minimum size
// for any box whose computed `overflow` is not `visible` — and Tailwind's
// `truncate` IS `overflow:hidden`. So on an element that carries `flex-1` and
// `truncate` TOGETHER, `min-w-0` changes nothing; measured in Chromium at #3474,
// the child box is 120px either way and the row overflows 0px either way. The
// shape that genuinely needs it is `flex-1` on a CONTAINER whose truncating text
// is a descendant: same fixture, the container renders 307px wide and overflows
// its 300px row by 187px, and adding `min-w-0` brings it back to 120px / 0px.
//
// What this rule therefore is, stated plainly so nobody has to re-derive it:
// a CONSISTENCY rule, not a correctness one. `min-w-0` on a `flex-1 truncate`
// element is inert *while* `truncate` sits on that element; it stops being inert
// the moment someone moves the truncation onto a child, which is exactly the
// edit that turns a working row into the container shape. Keeping the idiom
// uniform costs nothing and makes that edit safe. Claiming it is what fixed
// #3474 would cost the next reader an afternoon, so it does not claim that.
//
// The layout defect in #3474 itself was neither shape: five `shrink-0` siblings
// consumed the whole 390px row, leaving the `flex-1` name a legitimate zero. The
// fix is the wrap in `ProgramProjectsPage`, and `e2e/programs.spec.ts` is what
// holds it — no lint rule can see "these siblings do not fit".
//
// The CONTAINER family is deliberately NOT enforced here. The selector for it
// works (it is exercised in the self-test's documented-gap fixtures) and the
// tree carries 18 candidate sites, none of them reviewed — turning it on in this
// MR would red the pipeline for eighteen surfaces nobody has looked at, which is
// how a rule gets reverted rather than adopted. It is its own sweep, and rule
// 393 in `CLAUDE.md` records the measurement so the follow-up starts from
// evidence rather than from this comment.
//
// This is a CLASS-STRING rule, so it is textual by nature (rule 300(b)) — but it
// is written as an AST selector rather than a grep for two reasons that matter:
// a `className` string in this tree is routinely wrapped across lines (the
// offender that opened #3474 was one of them, and a line-oriented grep cannot
// see `flex-1` and `truncate` that a prettier wrap put on different lines), and
// the container family is a *structural* claim about an element and its child,
// which no grep can make at all.
//
// Known gaps, all with the same escape hatch (`// eslint-disable-next-line
// no-restricted-syntax` with a reason):
//   · classes split across separate string arguments of a `cn(...)`/`clsx(...)`
//     call are evaluated per string, so `clsx('flex-1 truncate', 'min-w-0')`
//     reports even though the rendered class list is correct. There is no such
//     site in the tree today.
//   · a class list assembled in an imported constant (a `styles.ts` recipe) is
//     invisible here, exactly as it is to NO_FOCUS_VISIBLE_ON_TRIGGER above.
//   · the container family looks one level down only. A truncating grandchild is
//     not reported — deeper nesting would need "no intermediate carries
//     `min-w-0`", which esquery cannot express, and guessing at it is how a rule
//     earns enough false positives to get switched off.
const FLEX_TRUNCATE_MESSAGE =
  '`flex-1 truncate` without `min-w-0` (rule 393). Inert while `truncate` sits on this element (overflow:hidden already zeroes min-width:auto), and load-bearing the moment the truncation moves to a child — keep the idiom uniform so that edit stays safe. Add `min-w-0`. If this genuinely is not a truncating flex child, add `// eslint-disable-next-line no-restricted-syntax` with a reason.';

// Both classes present, `min-w-0` absent, anywhere in the same attribute value.
// `[\s\S]` rather than `.` so a wrapped className is matched across its newlines.
//
// The leading `^` is load-bearing and is NOT decoration: esquery tests this with
// `RegExp.test`, which retries at every offset, so an unanchored lookahead group
// finds a *suffix* that satisfies it. `"min-w-0 flex-1 truncate"` — the correct
// form — then matches from the offset just past `min-w-0`, where the negative
// lookahead sees no remaining `min-w-0` and reports the fixed site as an
// offender. Anchoring forces all three lookaheads to be evaluated against the
// whole value exactly once. The self-test in
// `src/test/flexTruncateMinWidthRule.test.ts` pins the class-order permutations
// that caught this.
const FLEX_TRUNCATE_PAT =
  '/^(?=[\\s\\S]*\\bflex-1\\b)(?=[\\s\\S]*\\btruncate\\b)(?![\\s\\S]*\\bmin-w-0\\b)/';
const CLASS_NAME_VALUE = (pat) =>
  `JSXAttribute[name.name="className"] :matches(Literal[value=${pat}], TemplateElement[value.raw=${pat}])`;
export const NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0 = [
  {
    selector: CLASS_NAME_VALUE(FLEX_TRUNCATE_PAT),
    message: FLEX_TRUNCATE_MESSAGE,
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
      'no-restricted-syntax': [
        'error',
        NO_DEFAULT_EXPORT,
        ...NO_FOCUS_VISIBLE_ON_TRIGGER,
        ...NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0,
      ],
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
          message:
            'Use Number.isFinite — it does not coerce its argument like the global isFinite.',
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
      'no-restricted-syntax': [
        'error',
        NO_DEFAULT_EXPORT,
        ...NO_HARDCODED_ITERATION_LABEL,
        ...NO_FOCUS_VISIBLE_ON_TRIGGER,
        ...NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0,
      ],
    },
  },
  // Schedule-tree exemption for the standalone-trigger focus gate (rule 137,
  // restated by rule 4: `features/schedule/` stays `focus-visible:` deliberately).
  // This object must stay AFTER the iteration-label object above — flat config
  // replaces a rule's options rather than merging them, so re-specifying the list
  // without NO_FOCUS_VISIBLE_ON_TRIGGER is what carves the tree out, and the
  // iteration-label selectors have to be repeated here to survive that replacement.
  {
    files: ['src/features/schedule/**/*.tsx'],
    ignores: ['src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_DEFAULT_EXPORT,
        ...NO_HARDCODED_ITERATION_LABEL,
        ...NO_FLEX_TRUNCATE_WITHOUT_MIN_W_0,
      ],
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
          message:
            'Use Number.isFinite — it does not coerce its argument like the global isFinite.',
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
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT, NO_UNSCOPED_COMBOBOX],
    },
  },
  prettierConfig,
];
