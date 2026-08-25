import { describe, it, expect } from 'vitest';
import {
  ROW_VOCABULARY,
  ROW_NOUN,
  ROW_NOUN_PLURAL,
  countRows,
  insertBelowRowLabel,
  addFirstRowToLabel,
  ADD_FIRST_ROW_TO_PHASE,
} from './rowVocabulary';

/** Every leaf string in the governed object, with the path that produced it. */
function governedEntries(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      out.push([path, node]);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(ROW_VOCABULARY, '');
  // The standalone exports too. A token that lives outside the object is still
  // governed copy, and scanning only the object is how one would hide here.
  out.push(['ADD_FIRST_ROW_TO_PHASE', ADD_FIRST_ROW_TO_PHASE]);
  out.push(['insertBelowRowLabel', insertBelowRowLabel('Design')]);
  out.push(['addFirstRowToLabel', addFirstRowToLabel('Mobilization')]);
  return out;
}

describe('rowVocabulary — the module owns the words (#3031)', () => {
  it('exposes a non-trivial vocabulary, so every assertion below has something to bite on', () => {
    // The floor that keeps this whole file from passing vacuously. If a
    // refactor empties or restructures ROW_VOCABULARY, the type-word assertion
    // beneath would iterate nothing and report green — which is the exact
    // failure that kept the sub-12px lint gate useless through six sweeps.
    expect(governedEntries().length).toBeGreaterThanOrEqual(12);
  });

  it('never names a row TYPE on a surface that exists before the type does', () => {
    // The rule itself, asserted against the module's contents rather than
    // against the tree. Because `lock()` is not exported, this module is the
    // only door governed copy can come through — so policing what is behind the
    // door catches "Add a task" at the moment somebody writes it, rather than
    // on the third hand sweep.
    const TYPE_WORDS = /\b(tasks?|phases?|milestones?|subtasks?)\b/i;

    // The deliberate exceptions, and why each one is not a breach. The rule
    // forbids claiming a type nobody has established — it does not forbid naming
    // a type somebody has just chosen, or naming the CONTAINER a new row is
    // going into. Both shapes appear here and both are correct:
    //
    //   minted.newPhase          `+ Phase` declares a container; that IS a phase.
    //   create.phaseHasNoRows    a tooltip on a row already known to be a phase —
    //                            it is the CHILD's type that is unknown, and the
    //                            child is called an item, which is the point.
    //   ADD_FIRST_ROW_TO_PHASE   the same affordance's visible label.
    //
    // `addFirstRowToLabel` is NOT here, and the staleness check below is why it
    // is not: it interpolates the phase's own NAME ("Add first item to
    // Mobilization") and never says the word, so allow-listing it would have
    // been an allowance protecting nothing.
    const DECLARES_A_TYPE = new Set([
      'minted.newPhase',
      'create.phaseHasNoRows',
      'ADD_FIRST_ROW_TO_PHASE',
    ]);

    const offenders = governedEntries()
      .filter(([path]) => !DECLARES_A_TYPE.has(path))
      .filter(([, copy]) => TYPE_WORDS.test(copy));
    expect(offenders).toEqual([]);

    // And the exception is REAL — a stale allowance that no longer matches
    // anything would quietly weaken the rule above.
    for (const path of DECLARES_A_TYPE) {
      const entry = governedEntries().find(([p]) => p === path);
      expect(entry, `${path} is allow-listed but no longer exists`).toBeDefined();
      expect(
        TYPE_WORDS.test(entry![1]),
        `${path} is allow-listed but names no type — drop the allowance`,
      ).toBe(true);
    }
  });

  it('says "item", so the neutral noun is actually the one in use', () => {
    // Guards against the module existing but drifting to some other word — the
    // assertion above only says "not a type", which "New thing" also satisfies.
    const nounless = governedEntries().filter(
      ([path, copy]) => !/\bitems?\b/i.test(copy) && !path.startsWith('minted.newPhase'),
    );
    expect(nounless).toEqual([]);
  });

  it('writes each string exactly once, so "imported from one place" is unambiguous', () => {
    // Two slots with identical copy would make check-row-vocabulary.sh report a
    // duplicate against the module's own second use, and would leave a reader
    // unable to tell which token a surface is showing.
    const copies = governedEntries().map(([, copy]) => copy);
    expect(new Set(copies).size).toBe(copies.length);
  });
});

describe('rowVocabulary — the count helpers', () => {
  it('agrees with the bare nouns rather than restating them', () => {
    expect(countRows(1)).toBe(`1 ${ROW_NOUN}`);
    expect(countRows(4)).toBe(`4 ${ROW_NOUN_PLURAL}`);
  });

  it('pluralizes on 1, not on 0 — "0 items" is right and "0 item" is not', () => {
    expect(countRows(0)).toBe('0 items');
    expect(countRows(2)).toBe('2 items');
  });
});

describe('rowVocabulary — the interpolating labels', () => {
  it('names the anchor row, and falls back rather than dropping it from the sentence', () => {
    expect(insertBelowRowLabel('Design')).toBe('Insert an item below Design, at the same level');
    // A row with no name must not produce "Insert an item below , at the same
    // level" — the fallback is part of the governed string, not the caller's
    // problem to remember.
    expect(insertBelowRowLabel('')).toBe('Insert an item below this row, at the same level');
  });

  it("keeps the ghost affordance's two forms saying the same thing", () => {
    expect(addFirstRowToLabel('Mobilization')).toBe('Add first item to Mobilization');
    expect(ADD_FIRST_ROW_TO_PHASE).toBe('Add first item to this phase');
  });
});
