/**
 * The row vocabulary — **one** owner for the words the outline uses when a
 * row's type is not yet known (#3031).
 *
 * ## The rule this module enforces
 *
 * A row in the outline may be a task, a phase, a milestone or a subtask, and
 * `structure_role` is *declared* only once something declares it (ADR-0843).
 * So on the surfaces that exist **before** the type does — the column headers,
 * the create affordances, the placeholders, and the name a create path mints —
 * the noun must be **item**, because any other noun is a claim about a row that
 * has not been made yet.
 *
 * Everywhere else `task` is the correct word and is required. This module is
 * deliberately **not** a general copy store: it owns the governed surfaces and
 * nothing else. A "no `task` in user-facing strings" scan would be wrong and
 * worse than nothing, and nothing here licenses one.
 *
 * ## Why this exists rather than a third hand sweep
 *
 * The rule was swept by hand in #2952 (the creation surfaces) and again in
 * #3027 (the outline's headers, affordances and placeholders). Web rule 300
 * says a rule that needed a second manual sweep does not have a working
 * mechanism, and the second sweep found the instance that makes the point: the
 * `+ Item` button created a row literally **named `New task`**. A row's own
 * name is a stronger type claim than any button label, and it was invisible to
 * a sweep that was looking at buttons.
 *
 * ## What actually enforces it, and what does not
 *
 * Three layers, each doing one job, because no single one covers the class:
 *
 * 1. **The type system, at every call site.** Governed copy is a
 *    {@link VocabularyToken} — a branded string this module is the only minter
 *    of. A component whose copy prop is typed `VocabularyToken` cannot be
 *    passed a literal: `<X label="Add a task" />` is a compile error, and
 *    there is no roster to maintain and nothing to keep non-vacuous, because
 *    `tsc` cannot match nothing. This is web rule 325's conclusion — the
 *    recurrence guard is the type system, not a review — applied to a noun.
 *
 * 2. **`scripts/check-row-vocabulary.sh`**, for the residual the types cannot
 *    see: a component that renders a governed surface *without going through
 *    this module at all*. It reads the governed strings **out of this file**,
 *    so there is no second list to drift, and it also forbids a string-literal
 *    `name:` in a task-create payload — which is the exact shape of the
 *    `New task` defect above.
 *
 * 3. **`rowVocabularyLock.test.tsx`**, which renders the outline and checks the
 *    rendered DOM rather than the source: every `columnheader`, and every
 *    control whose accessible name opens with a create verb, must carry a
 *    token from here or be one of the affordances that *declares* a type on
 *    purpose (`+ Phase`, `+ Milestone`). It asserts a minimum candidate count,
 *    so a query that breaks fails loudly instead of passing by matching
 *    nothing — the failure that made the sub-12px lint gate useless through six
 *    sweeps.
 *
 * **What none of them catch, stated plainly:** a brand-new component that
 * hardcodes its own freshly-worded type claim and is never rendered by the
 * outline test. Layer 3 shrinks that gap to "not on the outline surface", and
 * layer 2 shrinks it to "not a copy of an existing string"; neither closes it.
 * A gate that does not say what it is blind to is how a rule survives two
 * sweeps, so it is said here.
 */

declare const VOCABULARY_BRAND: unique symbol;

/**
 * A string this module minted, and the only kind of string a governed copy slot
 * accepts.
 *
 * It is a `string` at runtime — it renders, concatenates and compares like any
 * other — and a nominal type at compile time, so an ordinary literal is not
 * assignable to it. That asymmetry is the whole mechanism: nothing changes for
 * a reader of the rendered surface, and a literal cannot reach one.
 */
export type VocabularyToken = string & { readonly [VOCABULARY_BRAND]: 'row-vocabulary' };

/**
 * Mint a token. **Not exported** — if a second module could mint, the brand
 * would say "somebody asserted this" rather than "this came from the
 * vocabulary", and the type would stop meaning anything.
 */
function lock(copy: string): VocabularyToken {
  return copy as VocabularyToken;
}

/**
 * The neutral noun itself, singular and plural, for the few places that build a
 * sentence around it rather than using a whole token.
 *
 * Exported so a count-bearing sentence ("3 items are now a phase") reaches the
 * same word as the buttons do, instead of agreeing with them by luck.
 */
export const ROW_NOUN = lock('item');
export const ROW_NOUN_PLURAL = lock('items');

/** `n` rows, in the neutral noun — `1 item`, `4 items`. */
export function countRows(n: number): VocabularyToken {
  return lock(`${n} ${n === 1 ? ROW_NOUN : ROW_NOUN_PLURAL}`);
}

/**
 * The governed copy, grouped by the surface it appears on.
 *
 * Grouping is documentation, not structure — the scan flattens this object and
 * does not care about the shape. Keep the groups aligned with the three
 * surfaces the rule names so a reader can tell at a glance whether a new string
 * belongs here at all.
 */
export const ROW_VOCABULARY = {
  /**
   * **Names a create path mints.** The highest-value slot and the one the
   * hand sweeps missed twice: the user sees this word in a Name cell, and if
   * they abandon the edit it becomes a real committed name in the plan, the WBS
   * and the Σ rollup.
   */
  minted: {
    /** The placeholder name every create path opens a row with. */
    newRow: lock('New item'),
    /**
     * A phase minted by `+ Phase`. **"Untitled", not "New"** (#2952): the word
     * is transient — the row opens select-all in cell-edit — but if the user
     * abandons the edit it becomes a real name, and "Untitled" reads as the
     * state it is rather than as a name someone might mistake for their own.
     * The type word is correct here because `+ Phase` declares one.
     */
    newPhase: lock('Untitled phase'),
    /**
     * Display fallback for a row whose name is blank. Neutral because the
     * surfaces that need it — the subtree-delete confirm, chiefly — are naming
     * a row whose type they have not established, even when they know it has
     * children.
     */
    untitledRow: lock('Untitled item'),
  },

  /** **Headers.** A column headed "Task" types every row under it. */
  header: {
    /** The outline's name column. */
    rowColumn: lock('Item'),
    /** Accessible name of the outline's header row. */
    columnsRow: lock('Item list columns'),
  },

  /**
   * **Create affordances.** Every control whose job is to bring a row into
   * existence, on every surface the outline has.
   */
  create: {
    /** The toolbar's insert button, and its stable accessible name. */
    toolbarButton: lock('+ Item'),
    toolbarLabel: lock('Add item'),
    /** The empty-state call to action, on the desktop outline and on mobile. */
    emptyStateButton: lock('+ Add item'),
    /** The footer row at the foot of the plan. */
    appendAtEnd: lock('Add an item at the end'),
    /** The row context menu's insert entry. */
    insertBelowMenu: lock('Insert item below'),
    /** The hover-revealed `+` disc on a row's bottom edge. */
    insertHereTitle: lock('Insert an item here'),
    /** The ghost affordance on a phase that has no structural child yet. */
    phaseHasNoRows: lock('This phase has no items yet'),
  },

  /**
   * **The outline itself.** Its accessible name is the container's claim about
   * everything inside it, so a treegrid called "Task list" — which is what both
   * surfaces announced until #3052 — types every row it holds, including the
   * phases and milestones the surface exists to show.
   *
   * The same token serves the Schedule outline and the Grid: `scheduleSurface`
   * models them as two surfaces of ONE row model (#2960), so two names for the
   * same collection would be the drift that module exists to prevent.
   */
  outline: {
    /** `role="treegrid"` / `role="grid"` accessible name. */
    label: lock('Item list'),
    /** The vertical splitter that resizes the outline against the canvas. */
    resizePanel: lock('Resize item list panel'),
  },

  /**
   * **Rename affordances.** A rename input sits on a row whose type is exactly
   * as undeclared as it was when the row was created.
   */
  rename: {
    /** For a rename input that cannot name the row it acts on. */
    row: lock('Rename item'),
  },

  /** **Placeholders and empty states.** The copy shown where rows are not. */
  empty: {
    /** The outline's empty state, desktop and mobile. */
    title: lock('No items yet'),
    /** The same, as a row inside the outline — note the full stop. */
    outlineRow: lock('No items yet.'),
    description: lock(
      "Add items to lay out your schedule — the timeline, critical path, and forecast appear as soon as there's work to plan.",
    ),
    mobileDescription: lock(
      'Add your first item to start building the schedule. Rows you create appear here in outline order.',
    ),
    /** The blank-project draft row's input. */
    firstRowPlaceholder: lock('Type your first item, then press Enter'),
    firstRowLabel: lock('First item name'),
  },
} as const;

/**
 * Accessible name for the row-edge `+`, which names the row it will insert
 * below.
 *
 * A function rather than a token because the copy interpolates, and the
 * fallback for an unnamed anchor is part of the governed string — a row with no
 * name must not silently drop out of the sentence.
 */
export function insertBelowRowLabel(anchorName: string): VocabularyToken {
  return lock(`Insert an item below ${anchorName || 'this row'}, at the same level`);
}

/** Accessible name for the ghost "add the first child" affordance on a phase. */
export function addFirstRowToLabel(phaseName: string): VocabularyToken {
  return lock(`Add first item to ${phaseName}`);
}

/** The same affordance's visible label, which names no particular phase. */
export const ADD_FIRST_ROW_TO_PHASE = lock('Add first item to this phase');

/**
 * Accessible name for a rename input that CAN name its row.
 *
 * Same fallback discipline as {@link insertBelowRowLabel}: a blank-named row
 * must not produce "Rename item " and rely on the accessible-name computation
 * trimming it back to something ambiguous. The row is identified or the
 * sentence says it could not be.
 */
export function renameRowLabel(rowName: string): VocabularyToken {
  return lock(`${ROW_VOCABULARY.rename.row} ${rowName || 'this row'}`);
}

/**
 * The outline splitter's `aria-valuetext`. Derived from the outline's own name
 * rather than restating it, so the splitter and the thing it resizes cannot
 * come to disagree — the defect #3031 found on the column resize handles.
 */
export function outlineWidthValueText(pixels: number): VocabularyToken {
  return lock(`${ROW_VOCABULARY.outline.label} ${pixels} pixels`);
}
