import { describe, it, expect } from 'vitest';
import { detectSpaceUnit, inferDepths, splitIndent } from './pasteHierarchy';

describe('splitIndent', () => {
  it('separates leading whitespace from the rest of the line', () => {
    expect(splitIndent('  Subtask')).toEqual({ indent: '  ', rest: 'Subtask' });
    expect(splitIndent('\t\tSubtask')).toEqual({ indent: '\t\t', rest: 'Subtask' });
    expect(splitIndent('Root')).toEqual({ indent: '', rest: 'Root' });
    expect(splitIndent('')).toEqual({ indent: '', rest: '' });
  });
});

describe('detectSpaceUnit', () => {
  it('picks the smallest nonzero leading-space run among space-only rows', () => {
    expect(detectSpaceUnit(['', '  ', '    ', '      '])).toBe(2);
    expect(detectSpaceUnit(['', '', ''])).toBe(2); // no signal → default
  });

  it('ignores rows that carry a leading tab', () => {
    expect(detectSpaceUnit(['\t', '   '])).toBe(3);
  });
});

describe('inferDepths', () => {
  it('tabs — one tab per level, unambiguous', () => {
    const lines = ['Phase 1', '\tDesign', '\t\tWireframes', '\tBuild', 'Phase 2'];
    expect(inferDepths(lines)).toEqual([0, 1, 2, 1, 0]);
  });

  it('spaces — infers the per-level unit from the block', () => {
    const lines = ['Phase 1', '  Design', '    Wireframes', '  Build', 'Phase 2'];
    expect(inferDepths(lines)).toEqual([0, 1, 2, 1, 0]);
  });

  it('spaces — a 4-space-per-level block', () => {
    const lines = ['Phase 1', '    Design', '        Wireframes'];
    expect(inferDepths(lines)).toEqual([0, 1, 2]);
  });

  it('mixed — tabs and spaces both appear across the block', () => {
    const lines = ['Phase 1', '\tDesign', '  Build']; // one tab-indented, one space-indented, both depth 1
    expect(inferDepths(lines)).toEqual([0, 1, 1]);
  });

  it('mixed within one line — leading tabs then leading spaces', () => {
    // A tab-indented block whose deepest row also has 2 extra leading spaces of
    // "sub-indent" — the tab still counts as exactly one level, the spaces then
    // add more via the block's detected unit (falls back to the default of 2
    // since every sampled row here carries a tab).
    const lines = ['Phase 1', '\tDesign', '\t  Detail'];
    expect(inferDepths(lines)).toEqual([0, 1, 2]);
  });

  it('ragged — a line indented more than one level past its predecessor is clamped', () => {
    const lines = ['Phase 1', '\t\t\tDeeply nested', '\tBack to one'];
    expect(inferDepths(lines)).toEqual([0, 1, 1]);
  });

  it('ragged — jumping straight to a deep space indent from root is clamped to depth 1', () => {
    const lines = ['Root', '        Way too deep'];
    expect(inferDepths(lines)).toEqual([0, 1]);
  });

  it('a flat block with no indentation is all depth 0', () => {
    expect(inferDepths(['Task A', 'Task B', 'Task C'])).toEqual([0, 0, 0]);
  });

  it('depth never goes negative', () => {
    expect(inferDepths(['Root'])).toEqual([0]);
  });

  it('empty input', () => {
    expect(inferDepths([])).toEqual([]);
  });
});
