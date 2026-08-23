/**
 * The dependency picker's footer names only keys the picker actually binds.
 *
 * This is the guard for the **class** #3024 belongs to, not for its instance.
 * The defect was not "Space is unbound" — it was that a surface *taught* `Space`
 * while nothing resolved it, and no test anywhere could go red for it: the
 * footer is a plain string, the handler is a `window` listener, and neither
 * knows the other exists. That is the same shape as the `⇥` the coach bar taught
 * (#3020) and the `⌥⌘G` before it, which is why web rule 326(d) says a gate over
 * teaching strings must **derive** the live set from the bindings rather than
 * restate it — a hand-listed set of expected chords rots exactly as the string
 * does.
 *
 * `scheduleTeachingChords.test.tsx` covers the outline's two teaching surfaces
 * and derives from `ScheduleView` + `TaskListRow`. It deliberately does not
 * reach this dialog: the picker runs its own listener, and its footer names keys
 * in words (`Space add`) rather than in the `<kbd>` glyph grammar that file
 * parses. So the derivation lives here, against the one file that binds them.
 */
import { describe, expect, it } from 'vitest';

const SOURCES: Record<string, string> = import.meta.glob('./ScheduleDependencyPicker.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const SOURCE = SOURCES['./ScheduleDependencyPicker.tsx'];

/** Comments name keys freely and bind nothing — they are not registrations. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every `e.key === '…'` the picker's keydown handler tests, normalized.
 *
 * Err **wide**: a false negative here ships another dead claim, while the worst
 * false positive admits a key nothing teaches.
 */
function liveKeys(): Set<string> {
  return new Set(
    [...stripComments(SOURCE).matchAll(/e\.key\s*===\s*'([^']*)'/g)].map((m) => m[1].toLowerCase()),
  );
}

/**
 * The footer's own text, read off the source rather than off a render.
 *
 * Both arms of the ternary have to be checked — the standalone-project string
 * and the programmed-project one differ, and rendering reaches only one at a
 * time.
 */
function footerClaims(): string[] {
  const hints = [...SOURCE.matchAll(/'([^']*·[^']*Esc cancel)'/g)].map((m) => m[1]);
  return hints;
}

/** Footer token → the `e.key` value that must resolve it. */
const TOKEN_KEYS: Record<string, string> = {
  '←→': 'ArrowLeft',
  '↑↓': 'ArrowUp',
  Space: ' ',
  Enter: 'Enter',
};

describe('the dependency picker teaches only keys it binds (#3024)', () => {
  it('derives real bindings from the handler, not an empty set', () => {
    // Without this the assertions below would pass vacuously the moment the
    // handler is refactored out of the `e.key === '…'` shape.
    const keys = liveKeys();
    expect(keys.has('arrowdown')).toBe(true);
    expect(keys.has('arrowup')).toBe(true);
    expect(keys.has('enter')).toBe(true);
    expect(keys.size).toBeGreaterThanOrEqual(5);
  });

  it('finds every footer string, both arms of both ternaries', () => {
    // Same guard on the other side: a footer that stopped matching would make
    // every claim assertion below true over an empty list. Four strings —
    // armed/unarmed × standalone/programmed — and a render reaches one at a time,
    // which is exactly why this is derived from source rather than from a DOM.
    const claims = footerClaims();
    expect(claims).toHaveLength(4);
    expect(claims.filter((c) => c.includes('←→'))).toHaveLength(2);
  });

  it('resolves every key the footer names', () => {
    const keys = liveKeys();
    const unresolved: string[] = [];
    for (const hint of footerClaims()) {
      for (const [token, key] of Object.entries(TOKEN_KEYS)) {
        if (!hint.includes(token)) continue;
        if (!keys.has(key.toLowerCase())) unresolved.push(`${token} (→ ${key})`);
      }
    }
    // The property, asserted as a list so a regression names the dead key rather
    // than a missing expected one. Before #3024 this read `['Space (→  )']`.
    expect(unresolved).toEqual([]);
  });

  it('names Space only in the armed variants, and names it somewhere', () => {
    // Non-vacuous in the other direction: the resolution guard above is satisfied
    // by a footer that teaches nothing at all. The footer must actually make the
    // claim — and must NOT make it while the caret still owns the keys, which is
    // the state in which "Space add" is false.
    const claims = footerClaims();
    const armed = claims.filter((hint) => hint.includes('Space add'));
    const unarmed = claims.filter((hint) => !hint.includes('Space add'));
    expect(armed).toHaveLength(2);
    expect(unarmed).toHaveLength(2);
    expect(unarmed.every((hint) => hint.includes('into list'))).toBe(true);
    expect(liveKeys().has(' ')).toBe(true);
  });

  it('does not teach Tab — the picker runs a focus trap, and Tab belongs to it', () => {
    // Scoped precisely: `useFocusTrap` binds Tab to keep focus in the dialog. A
    // footer chip naming it would read as "Tab does something in the list",
    // which is the WCAG 2.1.2 confusion #2192/#2727 fixed at the row layer.
    expect(footerClaims().some((hint) => /⇥|Tab/.test(hint))).toBe(false);
  });
});
