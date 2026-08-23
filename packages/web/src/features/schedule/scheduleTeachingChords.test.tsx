import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ScheduleCoachBar } from './buildMode/ScheduleCoachBar';
import { SessionTrail } from './trail/SessionTrail';
import { useTrailStore } from './trail/trailStore';

/**
 * #3020 — a teaching surface may not name a chord the keyboard layer cannot
 * resolve.
 *
 * Two dead chords shipped on the coach bar: `⌥⌘G` (no binding existed until
 * !2066) and `⇥` (Tab is bound to nothing and always will be — binding it
 * reproduces the WCAG 2.1.2 keyboard trap fixed in #2192/#2727, ADR-0776 §6).
 * Both got there the same way: a string was written next to a gesture, the
 * gesture moved, and nothing connected the two. So the point of this file is
 * **not** to assert the current strings are right — a list of expected chords
 * would rot exactly as the coach bar did. It is to derive the live set from the
 * *bindings* and check the strings against it, so the next rebind fails here
 * rather than shipping.
 *
 * ## What counts as a keystroke claim
 *
 * A `<kbd>` chip is a claim: it is the design's notation for "press this", and
 * its whole rationale is that *"each button documents its own shortcut instead
 * of needing a label"*. Prose is a claim only when it spells a modifier-bearing
 * chord. That distinction is load-bearing rather than convenient — the coach
 * bar's third line reads `+ ⇤ ⇥ ◆`, and those are the row's **button glyphs**,
 * not keys. It contains the very glyph this issue removed from the first line
 * and it is correct where it stands, so a guard that matched glyphs anywhere
 * would demand a wrong "fix" to a right string.
 *
 * A chip whose text does not parse as a chord at all (`hover a row`) is prose in
 * a chip and is skipped.
 *
 * ## Where the live set comes from
 *
 * Two keyboard layers, because the Schedule has two and the coach bar teaches
 * from both:
 *
 * 1. **View-scoped** — the object `ScheduleView` hands to `useScheduleKeyboard`,
 *    read straight off its `out['token'] =` registrations. Those tokens are
 *    already in `formatKey`'s grammar, so no translation is involved.
 * 2. **Row-scoped** — `TaskListRow`'s own keydown reducer, which is where
 *    indent/outdent/reorder actually live. It has no table to read, so the guard
 *    derives from its **guard expressions**: a statement testing `e.key` against
 *    a literal registers that key, qualified by whichever modifier properties
 *    that same statement tests. `⌥→` is live because
 *    `tryBuildModeIndent` reads `!e.altKey || (e.key !== 'ArrowRight' …)`, and it
 *    stops being live the moment that line changes.
 *
 * The row-scoped derivation is deliberately a *superset* — an unmodified
 * `e.key === 'Escape'` guard registers bare `escape`. Erring wide is right for
 * this gate: a false negative ships another dead chip, while the widest possible
 * false positive is admitting a chord no teaching surface names anyway.
 */

const SOURCES: Record<string, string> = import.meta.glob('./*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Comments name chords freely and bind nothing — they are not registrations. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Layer 1: the tokens `ScheduleView` registers on the `useScheduleKeyboard` table. */
function viewScopedBindings(source: string): string[] {
  return [...source.matchAll(/\bout\[\s*'([^']+)'\s*\]\s*=/g)].map((m) => m[1]);
}

/**
 * Layer 2: `TaskListRow`'s keydown guards.
 *
 * Ordered to match `formatKey`, which emits `mod`, then `shift`, then `alt`,
 * then the key token — a set that agreed on membership but not on spelling would
 * pass nothing.
 */
const MODIFIER_TESTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/e\.metaKey|e\.ctrlKey/, 'mod'],
  [/e\.shiftKey/, 'shift'],
  [/e\.altKey/, 'alt'],
];

function rowScopedBindings(source: string): string[] {
  const bindings: string[] = [];
  for (const statement of source.split('\n')) {
    // `e.key.toLowerCase() === 'd'` is how the ⌘D binding is written, and a
    // pattern that missed it would derive a set that is too NARROW — a teaching
    // surface adding a ⌘D chip would then fail this gate and be "fixed" to
    // remove a correct claim, which is the inverse of the error this file
    // exists to catch. The optional group is what keeps the derivation wide.
    const keys = [
      ...statement.matchAll(/e\.key(?:\.toLowerCase\(\))?\s*(?:===|!==)\s*'([^']+)'/g),
    ].map((m) => m[1].toLowerCase());
    if (keys.length === 0) continue;
    const modifiers = MODIFIER_TESTS.filter(([re]) => re.test(statement)).map(([, name]) => name);
    for (const key of keys) bindings.push([...modifiers, key].join('+'));
  }
  return bindings;
}

function liveChords(): Set<string> {
  const view = stripComments(SOURCES['./ScheduleView.tsx']);
  const row = stripComments(SOURCES['./TaskListRow.tsx']);
  return new Set([...viewScopedBindings(view), ...rowScopedBindings(row)]);
}

const MODIFIER_GLYPHS: Record<string, string> = {
  '⌘': 'mod',
  '⌃': 'ctrl',
  '⌥': 'alt',
  '⇧': 'shift',
};

const KEY_GLYPHS: Record<string, string> = {
  '→': 'arrowright',
  '←': 'arrowleft',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '⏎': 'enter',
  '⎋': 'escape',
  '⌫': 'backspace',
  '⇥': 'tab',
  // Outdent's glyph. Shift is part of the keystroke it would name, so it is
  // folded in here rather than left off — `⇤` and `⇥` must fail this gate for
  // the same reason, and for the same reason they must fail it identically.
  '⇤': 'tab',
};
const IMPLIES_SHIFT = new Set(['⇤']);

/** `formatKey`'s emission order — the spelling the live set is keyed on. */
const MODIFIER_ORDER = ['mod', 'shift', 'alt', 'ctrl'];

/**
 * Glyph run → `formatKey` token, or `null` when the text is not a chord at all.
 *
 * Returning `null` rather than throwing is what lets a chip carry a phrase
 * (`hover a row`) without the guard having to keep a list of exceptions.
 */
function parseChord(text: string): string | null {
  const chars = [...text.trim()];
  const modifiers: string[] = [];
  let i = 0;
  while (i < chars.length && MODIFIER_GLYPHS[chars[i]] !== undefined) {
    modifiers.push(MODIFIER_GLYPHS[chars[i]]);
    i += 1;
  }
  const rest = chars.slice(i).join('');
  if (rest.length === 0) return null;

  let key: string | null = null;
  if (KEY_GLYPHS[rest] !== undefined) {
    key = KEY_GLYPHS[rest];
    if (IMPLIES_SHIFT.has(rest)) modifiers.push('shift');
  } else if (/^F\d+$/i.test(rest)) {
    key = rest.toLowerCase();
  } else if (/^[a-z0-9?=+-]$/i.test(rest)) {
    key = rest.toLowerCase();
  }
  if (key === null) return null;

  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers, key].join('+');
}

/** Prose spells a chord only when it carries a modifier glyph. */
const PROSE_CHORD = /[⌘⌃⌥⇧]+[A-Za-z0-9→←↑↓⏎⇥⇤⌫⎋?]/g;

function keystrokeClaims(container: HTMLElement): string[] {
  const claims: string[] = [];
  for (const chip of container.querySelectorAll('kbd')) {
    const chord = parseChord(chip.textContent ?? '');
    if (chord !== null) claims.push(chord);
  }
  for (const run of (container.textContent ?? '').matchAll(PROSE_CHORD)) {
    const chord = parseChord(run[0]);
    if (chord !== null) claims.push(chord);
  }
  return [...new Set(claims)];
}

describe('the keyboard layers the guard derives from', () => {
  const live = liveChords();

  it('reads real registrations from both layers, not an empty set', () => {
    // If either extraction silently stops matching — a refactor renames `out`,
    // the row reducer moves file — every assertion below would pass vacuously.
    // These four pin that it did not.
    expect(live.has('mod+alt+g')).toBe(true); // ScheduleView, #2955 group
    expect(live.has('mod+z')).toBe(true); // ScheduleView, undo
    expect(live.has('?')).toBe(true); // ScheduleView, cheatsheet
    expect(live.has('alt+arrowright')).toBe(true); // TaskListRow, indent
    // Written as `e.key.toLowerCase() === 'd'`, so it pins that the row-layer
    // pattern reaches the normalized form and not just the bare comparison.
    expect(live.has('mod+d')).toBe(true); // TaskListRow, duplicate
    expect(live.size).toBeGreaterThan(15);
  });

  it('does not resolve Tab — the premise the coach bar got wrong', () => {
    // Not an incidental absence. Tab is left to native focus traversal on
    // purpose: intercepting it reproduces the WCAG 2.1.2 keyboard trap fixed in
    // #2192/#2727 (ADR-0776 §6). If this ever turns true, the fix is to find out
    // who bound Tab, not to update this expectation.
    expect(live.has('tab')).toBe(false);
    expect(live.has('shift+tab')).toBe(false);
  });
});

describe('ScheduleCoachBar names only chords the keyboard resolves', () => {
  afterEach(cleanup);

  it('every keystroke claim resolves against the registered bindings', () => {
    const live = liveChords();
    const { container } = render(<ScheduleCoachBar onDismiss={() => {}} onShowCheatsheet={() => {}} />);
    const claims = keystrokeClaims(container);

    // The property, asserted first so a regression names the dead chord rather
    // than a missing expected one: with `⇥` restored this reads `['tab']`.
    expect(claims.filter((chord) => !live.has(chord))).toEqual([]);

    // Non-vacuous: the bar really does teach chords, and the indent chip is the
    // one #3020 corrected from `⇥`.
    expect(claims).toContain('alt+arrowright');
    expect(claims.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves the row-control glyph run alone — those are buttons, not keys', () => {
    // `+ ⇤ ⇥ ◆` names what the row shows on hover. It is prose, carries no
    // modifier, and is correct; this pins that the guard above cannot be
    // satisfied by "fixing" it.
    const { container } = render(<ScheduleCoachBar onDismiss={() => {}} onShowCheatsheet={() => {}} />);
    expect(screen.getByText('+ ⇤ ⇥ ◆')).toBeInTheDocument();
    expect(keystrokeClaims(container)).not.toContain('tab');
  });
});

describe('SessionTrail names only chords the keyboard resolves', () => {
  beforeEach(() => useTrailStore.getState().clear());
  afterEach(cleanup);

  it('every keystroke claim in the open popover resolves', async () => {
    const live = liveChords();
    const user = userEvent.setup();
    useTrailStore.getState().record('p1', 'Permits indented under Mobilization.');
    const { container } = render(<SessionTrail onUndo={() => {}} />);
    await user.click(screen.getByRole('button', { name: /1 structural change this session/i }));

    // The panel's prose names no chord today — its scope sentence describes what
    // Undo covers rather than which key runs it. That makes this assertion a
    // *guard* rather than a check: it is armed for the next glyph somebody adds
    // to this surface, which is how `⌘Z` would have been caught had it been
    // written here instead of in a comment.
    expect(container.textContent ?? '').toContain('Undo reverses moves');
    expect(keystrokeClaims(container).filter((chord) => !live.has(chord))).toEqual([]);
  });
});
