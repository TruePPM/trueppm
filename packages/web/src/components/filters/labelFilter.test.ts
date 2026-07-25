import { describe, expect, it } from 'vitest';
import {
  LABEL_PARAM,
  countTasksByLabel,
  parseLabelIds,
  pruneUnknownLabelIds,
  serializeLabelIds,
  taskMatchesLabels,
} from './labelFilter';
import type { TaskLabel } from '@/types';

function label(id: string): TaskLabel {
  return { id, name: id, color: 'teal' } as TaskLabel;
}

const row = (...ids: string[]) => ({ labels: ids.map(label) });

describe('LABEL_PARAM', () => {
  it('is the Board’s `fl` key, so one bookmark format works on every view', () => {
    // Guards the ADR-0620 decision: the Grid/Backlog/Schedule adopt `?fl=`
    // verbatim rather than inventing their own key.
    expect(LABEL_PARAM).toBe('fl');
  });
});

describe('parseLabelIds', () => {
  it('splits a comma list', () => {
    expect(parseLabelIds('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing or blank param as no filter', () => {
    expect(parseLabelIds(null)).toEqual([]);
    expect(parseLabelIds(undefined)).toEqual([]);
    expect(parseLabelIds('')).toEqual([]);
    expect(parseLabelIds(',,')).toEqual([]);
  });

  it('trims whitespace and drops duplicates, keeping first-seen order', () => {
    // Order stability matters: the chip strip renders in this order, so a reload
    // must not reshuffle the chips.
    expect(parseLabelIds(' b , a ,b')).toEqual(['b', 'a']);
  });
});

describe('serializeLabelIds', () => {
  it('round-trips through parse', () => {
    expect(parseLabelIds(serializeLabelIds(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('yields an empty string for no selection so the host drops the key', () => {
    expect(serializeLabelIds([])).toBe('');
  });
});

describe('taskMatchesLabels', () => {
  it('matches everything when nothing is selected', () => {
    expect(taskMatchesLabels(row(), [])).toBe(true);
    expect(taskMatchesLabels({}, [])).toBe(true);
  });

  it('ORs within the facet — any selected label is enough', () => {
    expect(taskMatchesLabels(row('a'), ['a', 'b'])).toBe(true);
    expect(taskMatchesLabels(row('b'), ['a', 'b'])).toBe(true);
    expect(taskMatchesLabels(row('c'), ['a', 'b'])).toBe(false);
  });

  it('excludes rows with no labels, and rows whose labels were not loaded', () => {
    // The safe direction: a row we cannot prove carries the label is left out of
    // a positive filter rather than smuggled in.
    expect(taskMatchesLabels(row(), ['a'])).toBe(false);
    expect(taskMatchesLabels({}, ['a'])).toBe(false);
  });

  it('matches by id, not by name — renaming must not break a filter', () => {
    const renamed = { labels: [{ id: 'a', name: 'Renamed', color: 'teal' } as TaskLabel] };
    expect(taskMatchesLabels(renamed, ['a'])).toBe(true);
  });
});

describe('countTasksByLabel', () => {
  it('counts over the loaded rows', () => {
    const counts = countTasksByLabel([row('a'), row('a', 'b'), row()], ['a', 'b']);
    expect(counts).toEqual({ a: 2, b: 1 });
  });

  it('emits a visible 0 for a catalog label on no loaded row', () => {
    // This is the point of ADR-0620 decision 2: a zero is shown *before* the
    // user picks, so a zero-result selection is deliberate, not a dead end.
    expect(countTasksByLabel([row('a')], ['a', 'unused'])).toEqual({ a: 1, unused: 0 });
  });

  it('ignores labels that are not in the catalog', () => {
    expect(countTasksByLabel([row('ghost')], ['a'])).toEqual({ a: 0 });
  });
});

describe('pruneUnknownLabelIds', () => {
  it('drops ids the catalog no longer knows', () => {
    expect(pruneUnknownLabelIds(['a', 'gone'], ['a', 'b'])).toEqual(['a']);
  });

  it('leaves a fully-known selection untouched', () => {
    expect(pruneUnknownLabelIds(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});
