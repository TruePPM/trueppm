import { describe, it, expect } from 'vitest';
import type { ProjectResource } from '@/types';
import { buildPasteOperations } from './buildPasteOperations';
import { inferColumns } from './inferColumns';
import { parsePastedText } from './parsePastedText';

function member(id: string, name: string): ProjectResource {
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: id,
    resource: {
      id,
      name,
      email: `${id}@example.com`,
      jobRole: '',
      maxUnits: 1,
      calendarId: null,
      skills: [],
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  } as ProjectResource;
}

const ANA = member('r-ana', 'Ana Rivera');
const POOL = [ANA];

function sequentialIds() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('buildPasteOperations', () => {
  it('builds a flat batch of root-level creates', () => {
    const rows = parsePastedText('Survey\t5\nDesign\t3');
    const columns = inferColumns(rows, false);
    const result = buildPasteOperations(rows, columns, POOL, null, false, sequentialIds());

    expect(result.operations).toEqual([
      { op: 'create', id: 'id-1', data: { name: 'Survey', duration: 5 } },
      { op: 'create', id: 'id-2', data: { name: 'Design', duration: 3 } },
    ]);
    expect(result.createdIds).toEqual(['id-1', 'id-2']);
    expect(result.summary.rowCount).toBe(2);
    expect(result.summary.levelCount).toBe(1);
    expect(result.summary.needsDurationCount).toBe(0);
  });

  it('chains parent_id via client-minted ids for a nested paste (ADR-0772 forward refs)', () => {
    const rows = parsePastedText('Design\n\tWireframes\n\tReview\nBuild');
    const columns = inferColumns(rows, false);
    const result = buildPasteOperations(rows, columns, POOL, null, false, sequentialIds());

    expect(result.operations).toEqual([
      { op: 'create', id: 'id-1', data: { name: 'Design' } },
      { op: 'create', id: 'id-2', data: { name: 'Wireframes', parent_id: 'id-1' } },
      { op: 'create', id: 'id-3', data: { name: 'Review', parent_id: 'id-1' } },
      { op: 'create', id: 'id-4', data: { name: 'Build' } },
    ]);
    expect(result.summary.levelCount).toBe(2);
  });

  it('a fresh subtree pasted under the currently focused row uses it as depth-0 parent', () => {
    const rows = parsePastedText('Design\n\tWireframes');
    const columns = inferColumns(rows, false);
    const result = buildPasteOperations(rows, columns, POOL, 'phase-1', false, sequentialIds());

    expect(result.operations[0].data).toMatchObject({ parent_id: 'phase-1' });
    expect(result.operations[1].data).toMatchObject({ parent_id: 'id-1' });
  });

  it('reports every id that gained a child, including a pre-existing paste target', () => {
    const rows = parsePastedText('Design\n\tWireframes\n\tReview\nBuild');
    const columns = inferColumns(rows, false);
    const result = buildPasteOperations(rows, columns, POOL, 'phase-1', false, sequentialIds());

    // 'phase-1' is the pre-existing focused row the paste targeted — it gains a
    // child ('Design') too, so it must auto-expand exactly like a freshly
    // created parent, or the paste lands invisible under it.
    expect(result.parentIds).toEqual(new Set(['phase-1', 'id-1']));
  });

  it('a row with no duration cell is flagged needs-duration, not defaulted client-side', () => {
    const rows = parsePastedText('Survey\t5\nDesign\t');
    const columns = inferColumns(rows, false);
    const result = buildPasteOperations(rows, columns, POOL, null, false, sequentialIds());

    expect(result.operations[1].data).not.toHaveProperty('duration');
    expect(result.needsDurationIds.has('id-2')).toBe(true);
    expect(result.summary.needsDurationCount).toBe(1);
  });

  it('excludes the header row from the batch', () => {
    const rows = parsePastedText('Task\tOwner\nSurvey\tAna Rivera');
    const columns = inferColumns(rows, true);
    const result = buildPasteOperations(rows, columns, POOL, null, true, sequentialIds());

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].data.name).toBe('Survey');
    expect(result.summary.rowCount).toBe(1);
  });

  it('resolves an owner column value against the roster', () => {
    const rows = parsePastedText('Task\tOwner\nSurvey\tAna Rivera');
    const columns = inferColumns(rows, true);
    const result = buildPasteOperations(rows, columns, POOL, null, true, sequentialIds());

    expect(result.operations[0].data.owners).toEqual([{ resource: 'r-ana', units: 1 }]);
  });

  it('an unresolvable owner value is silently dropped, not rejected — the row still commits', () => {
    const rows = parsePastedText('Task\tOwner\nSurvey\tSomeone Unknown');
    const columns = inferColumns(rows, true);
    const result = buildPasteOperations(rows, columns, POOL, null, true, sequentialIds());

    expect(result.operations[0].data).not.toHaveProperty('owners');
    expect(result.operations).toHaveLength(1);
  });

  it('skips a row whose name cell is blank rather than creating an empty task', () => {
    // Column 0 (an ignored id column) keeps every line free of leading
    // whitespace, so the blank name cell here is a genuinely empty column
    // value — not indentation.
    const rows = parsePastedText('#\tTask\tDuration\n1\tSurvey\t5\n2\t\t3\n3\tDesign\t2');
    const columns = inferColumns(rows, true);
    const result = buildPasteOperations(rows, columns, POOL, null, true, sequentialIds());

    expect(result.operations.map((op) => op.data.name)).toEqual(['Survey', 'Design']);
  });

  it('reports matched and ignored columns', () => {
    const rows = parsePastedText('Task\tDuration\tNotes\nSurvey\t5\tfree text');
    const columns = inferColumns(rows, true);
    const result = buildPasteOperations(rows, columns, POOL, null, true, sequentialIds());

    expect(result.summary.matchedFields.sort()).toEqual(['duration', 'name']);
    expect(result.summary.ignoredColumnCount).toBe(1);
  });
});
