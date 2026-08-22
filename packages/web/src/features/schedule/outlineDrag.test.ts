import { describe, expect, it } from 'vitest';
import { WBS_INDENT } from './scheduleConstants';
import {
  describeDropIntent,
  dropIndicatorGeometry,
  moveDestinations,
  outlineGuideX,
  planOutlineMove,
  resolveDropIntent,
  type OutlineDragRow,
} from './outlineDrag';

const ROW_H = 28;

function row(over: Partial<OutlineDragRow> & { id: string; wbs: string }): OutlineDragRow {
  return {
    name: over.id,
    parentId: null,
    isMilestone: false,
    hasChildren: false,
    ...over,
  };
}

/**
 *   0  phase   1        (has children)
 *   1    a     1.1
 *   2    b     1.2
 *   3  gate    2        (milestone)
 *   4  tail    3
 */
const ROWS: OutlineDragRow[] = [
  row({ id: 'phase', wbs: '1', name: 'Mobilization', hasChildren: true }),
  row({ id: 'a', wbs: '1.1', name: 'Survey', parentId: 'phase' }),
  row({ id: 'b', wbs: '1.2', name: 'Permits', parentId: 'phase' }),
  row({ id: 'gate', wbs: '2', name: 'Notice to proceed', isMilestone: true }),
  row({ id: 'tail', wbs: '3', name: 'Closeout' }),
];

/** Middle of row `i` — the "onto" band. */
const onto = (i: number) => i * ROW_H + ROW_H / 2;
/** Top edge of row `i` — the gap above it. */
const above = (i: number) => i * ROW_H + 1;

describe('resolveDropIntent — the three zones', () => {
  it('reads the middle of a row as "become its child"', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'tail', localY: onto(0), rowHeight: ROW_H }))
      .toEqual({ kind: 'child', targetId: 'phase', level: 2, becomesPhase: false });
  });

  it('reads the top edge as a sibling of the row below it', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'tail', localY: above(2), rowHeight: ROW_H }))
      .toEqual({
        kind: 'sibling',
        referenceId: 'b',
        position: 'before',
        newParentId: 'phase',
        level: 2,
      });
  });

  it('reads the bottom edge as a sibling of the row below THAT', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'tail',
      localY: 1 * ROW_H + (ROW_H - 1),
      rowHeight: ROW_H,
    });
    expect(intent).toEqual({
      kind: 'sibling',
      referenceId: 'b',
      position: 'before',
      newParentId: 'phase',
      level: 2,
    });
  });

  it('past the last row means "after the last row", at its level', () => {
    expect(
      resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: 99 * ROW_H, rowHeight: ROW_H }),
    ).toEqual({
      kind: 'sibling',
      referenceId: 'tail',
      position: 'after',
      newParentId: null,
      level: 1,
    });
  });
});

describe('resolveDropIntent — a leaf target becomes a phase', () => {
  it('says so for a target with no children', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'a',
      localY: onto(4),
      rowHeight: ROW_H,
    });
    expect(intent).toEqual({ kind: 'child', targetId: 'tail', level: 2, becomesPhase: true });
  });

  it('does not say so for a target that is already a phase', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'tail',
      localY: onto(0),
      rowHeight: ROW_H,
    });
    expect(intent).toMatchObject({ kind: 'child', becomesPhase: false });
  });
});

describe('resolveDropIntent — the two refusals', () => {
  it('a milestone refuses work', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: onto(3), rowHeight: ROW_H }))
      .toEqual({ kind: 'refused', reason: 'milestone', targetId: 'gate', level: 2 });
  });

  it('a row refuses its own subtree', () => {
    expect(
      resolveDropIntent({ rows: ROWS, draggedId: 'phase', localY: onto(1), rowHeight: ROW_H }),
    ).toEqual({ kind: 'refused', reason: 'own-subtree', targetId: 'a', level: 3 });
  });

  it('a row refuses itself', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'phase', localY: onto(0), rowHeight: ROW_H }))
      .toEqual({ kind: 'refused', reason: 'own-subtree', targetId: 'phase', level: 2 });
  });

  it('a gap inside the dragged row’s own subtree is refused too', () => {
    // Between "Survey" and "Permits" — both are children of the dragged phase.
    expect(
      resolveDropIntent({ rows: ROWS, draggedId: 'phase', localY: above(2), rowHeight: ROW_H }),
    ).toEqual({ kind: 'refused', reason: 'own-subtree', targetId: 'b', level: 2 });
  });

  it('a prefix collision is not subtree membership', () => {
    // `1.1` must not claim `1.10` — the trailing dot is what separates them.
    const wide = [
      row({ id: 'p', wbs: '1', hasChildren: true }),
      row({ id: 'one', wbs: '1.1', parentId: 'p', hasChildren: false }),
      row({ id: 'ten', wbs: '1.10', parentId: 'p' }),
    ];
    expect(resolveDropIntent({ rows: wide, draggedId: 'one', localY: onto(2), rowHeight: ROW_H }))
      .toMatchObject({ kind: 'child', targetId: 'ten' });
  });
});

describe('resolveDropIntent — positions that change nothing say nothing', () => {
  it('dropping onto the row that is already the parent', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: onto(0), rowHeight: ROW_H }))
      .toEqual({ kind: 'none' });
  });

  it('dropping in the gap directly above the dragged row', () => {
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'b', localY: above(2), rowHeight: ROW_H }))
      .toEqual({ kind: 'none' });
  });

  it('an empty list, a zero row height, and an unknown dragged id', () => {
    expect(resolveDropIntent({ rows: [], draggedId: 'a', localY: 10, rowHeight: ROW_H })).toEqual({
      kind: 'none',
    });
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: 10, rowHeight: 0 })).toEqual({
      kind: 'none',
    });
    expect(resolveDropIntent({ rows: ROWS, draggedId: 'ghost', localY: 10, rowHeight: ROW_H }))
      .toEqual({ kind: 'none' });
  });
});

describe('resolveDropIntent — a coarse pointer gets thirds, not an 8px edge', () => {
  // 9px into a 28px row: past the 8px fine edge, still inside the 9.33px
  // coarse one (28 / 3). One pixel is the whole difference between the two
  // models at this y — which is the point: a finger cannot aim at that pixel.
  const y = 1 * ROW_H + 9;

  it('a mouse at 9px is already in the child band', () => {
    expect(
      resolveDropIntent({ rows: ROWS, draggedId: 'tail', localY: y, rowHeight: ROW_H }),
    ).toMatchObject({ kind: 'child', targetId: 'a' });
  });

  it('a finger at the same 9px is still in the gap', () => {
    expect(
      resolveDropIntent({ rows: ROWS, draggedId: 'tail', localY: y, rowHeight: ROW_H, coarse: true }),
    ).toMatchObject({ kind: 'sibling', referenceId: 'a', position: 'before' });
  });
});

describe('describeDropIntent — the consequence, before release', () => {
  const describe_ = (id: string, y: number) =>
    describeDropIntent(
      resolveDropIntent({ rows: ROWS, draggedId: id, localY: y, rowHeight: ROW_H }),
      ROWS,
      id,
    );

  it('a leaf target announces that it becomes a phase', () => {
    expect(describe_('a', onto(4))).toEqual({
      chip: '↳ becomes a phase',
      sentence: 'Drop to move Survey into Closeout, which becomes a phase.',
      tone: 'ok',
    });
  });

  it('an existing phase target says "into this phase"', () => {
    expect(describe_('tail', onto(0))?.chip).toBe('into this phase');
  });

  it('a sibling drop names the level it lands at', () => {
    expect(describe_('tail', above(2))?.chip).toBe('same level as Permits');
  });

  it('a milestone says a gate cannot hold work', () => {
    expect(describe_('a', onto(3))).toEqual({
      chip: 'a gate cannot hold work',
      sentence: 'Notice to proceed is a milestone — a gate cannot hold work.',
      tone: 'refused',
    });
  });

  it('a subtree refusal names the row, not the mechanism', () => {
    expect(describe_('phase', onto(1))).toEqual({
      chip: 'can’t go inside itself',
      sentence: 'Mobilization can’t move inside its own subtree.',
      tone: 'refused',
    });
  });

  it('a nameless row is "Untitled", not a gap', () => {
    const rows = [row({ id: 'x', wbs: '1', name: '  ' }), row({ id: 'y', wbs: '2', name: 'Y' })];
    const intent = resolveDropIntent({
      rows,
      draggedId: 'y',
      localY: onto(0),
      rowHeight: ROW_H,
    });
    expect(describeDropIntent(intent, rows, 'y')?.sentence).toContain('into Untitled');
  });

  it('says nothing at all for a position that changes nothing', () => {
    expect(describeDropIntent({ kind: 'none' }, ROWS, 'a')).toBeNull();
  });
});

describe('dropIndicatorGeometry — sibling and child are one indent step apart', () => {
  it('a sibling line sits at its own level’s guide x', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'tail',
      localY: above(2),
      rowHeight: ROW_H,
    });
    expect(dropIndicatorGeometry(intent, ROWS, ROW_H)).toEqual({
      lineTop: 2 * ROW_H,
      targetTop: 2 * ROW_H,
      indent: outlineGuideX(2),
    });
  });

  it('a child line sits exactly ONE WBS_INDENT deeper, at the target’s bottom edge', () => {
    const sibling = dropIndicatorGeometry(
      resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: above(4), rowHeight: ROW_H }),
      ROWS,
      ROW_H,
    );
    const child = dropIndicatorGeometry(
      resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: onto(4), rowHeight: ROW_H }),
      ROWS,
      ROW_H,
    );
    // Same pointer row, two different claims — told apart by x, not by color.
    expect(child!.indent - sibling!.indent).toBe(WBS_INDENT);
    expect(child!.lineTop).toBe(5 * ROW_H);
  });

  it('a refusal still marks the row that said no', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'a',
      localY: onto(3),
      rowHeight: ROW_H,
    });
    expect(dropIndicatorGeometry(intent, ROWS, ROW_H)).toMatchObject({ targetTop: 3 * ROW_H });
  });

  it('is null for "none" and for an intent whose rows have gone', () => {
    expect(dropIndicatorGeometry({ kind: 'none' }, ROWS, ROW_H)).toBeNull();
    expect(
      dropIndicatorGeometry(
        { kind: 'child', targetId: 'ghost', level: 2, becomesPhase: false },
        ROWS,
        ROW_H,
      ),
    ).toBeNull();
  });
});

/**
 * Web rule 309(a): the edge-equals-deepest-guide identity is invisible to every
 * other check, and a change to `WBS_INDENT` or to either formula would silently
 * break the design while everything still renders.
 */
describe('outlineGuideX — one ladder for the guides and the drop line', () => {
  it('matches the task cell’s own paddingLeft formula', () => {
    for (const level of [1, 2, 3, 7]) {
      expect(outlineGuideX(level)).toBe((level - 1) * WBS_INDENT + 8);
    }
  });

  it('a child drop lands on the x its new depth guide will run on', () => {
    const child = dropIndicatorGeometry(
      resolveDropIntent({ rows: ROWS, draggedId: 'a', localY: onto(4), rowHeight: ROW_H }),
      ROWS,
      ROW_H,
    );
    // "tail" is level 1, so the moved row becomes level 2.
    expect(child!.indent).toBe(outlineGuideX(2));
  });
});

describe('planOutlineMove — a position anchor, not a sibling list', () => {
  it('a child drop appends: parent named, no anchor', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'tail',
      localY: onto(0),
      rowHeight: ROW_H,
    });
    expect(planOutlineMove(intent, ROWS, 'tail')).toEqual({
      taskId: 'tail',
      newParentId: 'phase',
      beforeSiblingId: null,
      destinationName: 'Mobilization',
      becomesPhase: false,
    });
  });

  it('a "before" sibling drop anchors on that row', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'tail',
      localY: above(2),
      rowHeight: ROW_H,
    });
    expect(planOutlineMove(intent, ROWS, 'tail')).toMatchObject({
      newParentId: 'phase',
      beforeSiblingId: 'b',
    });
  });

  it('an "after" drop anchors on the NEXT SIBLING, skipping the target’s subtree', () => {
    // After "Mobilization" must mean "before Notice to proceed", not "before
    // Survey" — Survey is inside Mobilization.
    const rows = ROWS;
    const intent = { kind: 'sibling' as const, referenceId: 'phase', position: 'after' as const, newParentId: null, level: 1 };
    expect(planOutlineMove(intent, rows, 'tail')).toMatchObject({ beforeSiblingId: 'gate' });
  });

  it('an "after the last row" drop has no anchor', () => {
    const intent = resolveDropIntent({
      rows: ROWS,
      draggedId: 'a',
      localY: 99 * ROW_H,
      rowHeight: ROW_H,
    });
    expect(planOutlineMove(intent, ROWS, 'a')).toMatchObject({
      newParentId: null,
      beforeSiblingId: null,
    });
  });

  it('is null for every refusal and every no-op', () => {
    expect(planOutlineMove({ kind: 'none' }, ROWS, 'a')).toBeNull();
    expect(
      planOutlineMove(
        { kind: 'refused', reason: 'milestone', targetId: 'gate', level: 2 },
        ROWS,
        'a',
      ),
    ).toBeNull();
  });

  it('is null when the intent names rows that are gone', () => {
    expect(
      planOutlineMove(
        { kind: 'child', targetId: 'ghost', level: 2, becomesPhase: false },
        ROWS,
        'a',
      ),
    ).toBeNull();
    expect(
      planOutlineMove(
        { kind: 'child', targetId: 'phase', level: 2, becomesPhase: false },
        ROWS,
        'ghost',
      ),
    ).toBeNull();
  });
});

describe('moveDestinations — the picker applies the drag’s refusals by omission', () => {
  const destinations = moveDestinations(ROWS, 'a');

  it('always offers the top level first', () => {
    expect(destinations[0]).toEqual({
      id: null,
      name: 'Top level',
      level: 0,
      becomesPhase: false,
      isCurrentParent: false,
    });
  });

  it('omits milestones — a gate cannot hold work', () => {
    expect(destinations.map((d) => d.id)).not.toContain('gate');
  });

  it('omits the row itself and everything under it', () => {
    expect(moveDestinations(ROWS, 'phase').map((d) => d.id)).toEqual([null, 'tail']);
  });

  it('marks the current parent so the list does not read as a set of moves', () => {
    expect(destinations.find((d) => d.id === 'phase')?.isCurrentParent).toBe(true);
  });

  it('marks a leaf destination as one that becomes a phase', () => {
    expect(destinations.find((d) => d.id === 'tail')).toMatchObject({ becomesPhase: true });
  });

  it('is empty for a row that is not in the plan', () => {
    expect(moveDestinations(ROWS, 'ghost')).toEqual([]);
  });
});
