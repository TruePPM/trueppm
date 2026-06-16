import { describe, expect, it, vi } from 'vitest';
import { filterCommandItems, type CommandItem } from './commandItems';

const item = (over: Partial<CommandItem>): CommandItem => ({
  id: over.id ?? 'x',
  label: over.label ?? 'Label',
  group: over.group ?? 'jump',
  tag: over.tag ?? 'View',
  detail: over.detail,
  keywords: over.keywords,
  gated: over.gated,
  run: over.run ?? vi.fn(),
});

describe('filterCommandItems', () => {
  const items = [
    item({ id: 'a', label: 'My Work', tag: 'View' }),
    item({ id: 'b', label: 'Apollo', tag: 'Program', keywords: 'APL' }),
    item({ id: 'c', label: 'Switch theme', tag: 'Action', keywords: 'dark light appearance' }),
  ];

  it('returns everything for an empty or whitespace query', () => {
    expect(filterCommandItems(items, '')).toHaveLength(3);
    expect(filterCommandItems(items, '   ')).toHaveLength(3);
  });

  it('matches on label, case-insensitively', () => {
    expect(filterCommandItems(items, 'apollo').map((i) => i.id)).toEqual(['b']);
    expect(filterCommandItems(items, 'WORK').map((i) => i.id)).toEqual(['a']);
  });

  it('matches on tag and keywords', () => {
    expect(filterCommandItems(items, 'program').map((i) => i.id)).toEqual(['b']);
    expect(filterCommandItems(items, 'apl').map((i) => i.id)).toEqual(['b']);
    expect(filterCommandItems(items, 'dark').map((i) => i.id)).toEqual(['c']);
  });

  it('matches on the detail line (task short id / status)', () => {
    const task = item({ id: 't', label: 'Open task: Wire OAuth', group: 'task', tag: 'Task', detail: '1.4.2 · In progress' });
    expect(filterCommandItems([task], '1.4.2').map((i) => i.id)).toEqual(['t']);
    expect(filterCommandItems([task], 'in progress').map((i) => i.id)).toEqual(['t']);
  });

  it('preserves input order across groups', () => {
    // 'a' hits Apollo/Program (b) and Action/appearance (c) but not "My Work View" (a).
    expect(filterCommandItems(items, 'a').map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterCommandItems(items, 'zzz')).toEqual([]);
  });
});
