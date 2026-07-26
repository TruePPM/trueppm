/**
 * Saved-view filter summary + dangling-label detection (#2394).
 *
 * The load-bearing cases are the two that are easy to get subtly wrong: an
 * unloaded catalog must not read as "everything was deleted", and a label id
 * from another project must produce exactly the same anonymous tombstone as a
 * locally-deleted one.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSavedView, missingLabelIds, savedViewAriaLabel } from './savedViewSummary';
import type { Label } from '@/hooks/useLabels';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';

function label(id: string, name: string, color = 'teal'): Label {
  return { id, name, color, position: 0, serverVersion: 1, taskCount: 0 };
}

function config(over: Partial<BoardViewConfig> = {}): BoardViewConfig {
  return {
    sort: 'priority',
    showWip: false,
    showColTints: false,
    evmMode: 'off' as BoardViewConfig['evmMode'],
    showCost: false,
    riskLinkedOnly: false,
    filters: { assignees: [], priority: [], due: [], labels: [] },
    ...over,
  };
}

describe('summarizeSavedView — facet segments', () => {
  it('counts owners rather than naming them', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: ['a', 'b'], priority: [], due: [], labels: [] } }),
      [],
    );
    // Four names would wrap the menu row or truncate mid-name; the count is the
    // honest summary and the panel has the detail.
    expect(s.segments).toEqual(['Owner: 2']);
  });

  it('enumerates priority and due windows, whose vocabularies are small and fixed', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: [], priority: ['high'], due: ['overdue'], labels: [] } }),
      [],
    );
    expect(s.segments).toEqual(['Priority: High', 'Due: Overdue']);
  });

  it('includes toggles that change WHICH cards show, not display-only ones', () => {
    const s = summarizeSavedView(
      config({ riskLinkedOnly: true, cpOnly: true, showColTints: true, showCost: true }),
      [],
    );
    expect(s.segments).toEqual(['Risk-linked', 'Critical path']);
  });

  it('reports an empty view so the row renders no meta line at all', () => {
    expect(summarizeSavedView(config(), []).isEmpty).toBe(true);
    expect(summarizeSavedView(undefined, []).isEmpty).toBe(true);
  });
});

describe('summarizeSavedView — label resolution', () => {
  it('resolves a live label to its name AND color, for the swatch', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: [], priority: [], due: [], labels: ['l1'] } }),
      [label('l1', 'Needs review', 'amber')],
    );
    expect(s.labels).toEqual([{ id: 'l1', name: 'Needs review', color: 'amber' }]);
    expect(s.hasMissingLabel).toBe(false);
  });

  it('renders a deleted label anonymously — the catalog omits it, so there is no name', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: [], priority: [], due: [], labels: ['gone'] } }),
      [label('l1', 'Live')],
    );
    expect(s.labels).toEqual([{ id: 'gone', name: null, color: null }]);
    expect(s.hasMissingLabel).toBe(true);
  });

  it('treats a FOREIGN project label id identically to a deleted one', () => {
    // #2385 stores label ids without validating them, so a saved view can carry
    // an id owned by another project. Resolving it must never leak that
    // project's label name — it takes the same anonymous tombstone path.
    const foreign = summarizeSavedView(
      config({ filters: { assignees: [], priority: [], due: [], labels: ['other-project'] } }),
      [label('l1', 'Live')],
    );
    const deleted = summarizeSavedView(
      config({ filters: { assignees: [], priority: [], due: [], labels: ['deleted'] } }),
      [label('l1', 'Live')],
    );
    expect(foreign.labels[0]?.name).toBe(deleted.labels[0]?.name);
    expect(foreign.labels[0]?.name).toBeNull();
  });
});

describe('missingLabelIds', () => {
  it('returns nothing while the catalog is still loading', () => {
    // Returning ids here would flash "this label was deleted" on every board
    // load, before the catalog resolves, for views whose labels are fine.
    expect(
      missingLabelIds(
        config({ filters: { assignees: [], priority: [], due: [], labels: ['l1'] } }),
        undefined,
      ),
    ).toEqual([]);
  });

  it('returns only the ids absent from the catalog', () => {
    expect(
      missingLabelIds(
        config({ filters: { assignees: [], priority: [], due: [], labels: ['l1', 'gone'] } }),
        [label('l1', 'Live')],
      ),
    ).toEqual(['gone']);
  });

  it('returns nothing for an empty catalog and no label filter', () => {
    expect(missingLabelIds(config(), [])).toEqual([]);
  });
});

describe('savedViewAriaLabel', () => {
  it('is just the name when there is nothing to summarize', () => {
    expect(savedViewAriaLabel('Q3 triage', summarizeSavedView(config(), []))).toBe('Q3 triage');
  });

  it('announces a deleted label as not applied, rather than dropping it', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: [], priority: [], due: [], labels: ['gone'] } }),
      [],
    );
    expect(savedViewAriaLabel('Q3 triage', s)).toContain('1 deleted label, not applied');
  });

  it('names live labels and counts missing ones together', () => {
    const s = summarizeSavedView(
      config({ filters: { assignees: ['a'], priority: [], due: [], labels: ['l1', 'x', 'y'] } }),
      [label('l1', 'Rework')],
    );
    const spoken = savedViewAriaLabel('Triage', s);
    expect(spoken).toContain('Owner: 1');
    expect(spoken).toContain('Labels: Rework');
    expect(spoken).toContain('2 deleted labels, not applied');
  });
});
