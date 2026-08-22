import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OutlineDropIndicator } from './OutlineDropIndicator';
import { outlineGuideX, type OutlineDragRow } from './outlineDrag';
import { WBS_INDENT } from './scheduleConstants';

const ROW_H = 28;

const ROWS: OutlineDragRow[] = [
  { id: 'phase', name: 'Mobilization', wbs: '1', parentId: null, isMilestone: false, hasChildren: true },
  { id: 'a', name: 'Survey', wbs: '1.1', parentId: 'phase', isMilestone: false, hasChildren: false },
  { id: 'gate', name: 'NTP', wbs: '2', parentId: null, isMilestone: true, hasChildren: false },
];

function renderIndicator(intent: Parameters<typeof OutlineDropIndicator>[0]['intent']) {
  return render(
    <OutlineDropIndicator intent={intent} rows={ROWS} draggedId="a" rowHeight={ROW_H} />,
  );
}

describe('OutlineDropIndicator — it states the consequence, not just a position', () => {
  it('names what a leaf target becomes', () => {
    renderIndicator({ kind: 'child', targetId: 'gate', level: 2, becomesPhase: true });
    expect(screen.getByTestId('outline-drop-consequence')).toHaveTextContent('↳ becomes a phase');
  });

  it('names an existing phase as one', () => {
    renderIndicator({ kind: 'child', targetId: 'phase', level: 2, becomesPhase: false });
    expect(screen.getByTestId('outline-drop-consequence')).toHaveTextContent('into this phase');
  });

  it('names the level a sibling drop lands at', () => {
    renderIndicator({
      kind: 'sibling',
      referenceId: 'a',
      position: 'before',
      newParentId: 'phase',
      level: 2,
    });
    expect(screen.getByTestId('outline-drop-consequence')).toHaveTextContent('same level as Survey');
  });

  it('says why a milestone refused, rather than going blank', () => {
    renderIndicator({ kind: 'refused', reason: 'milestone', targetId: 'gate', level: 2 });
    const chip = screen.getByTestId('outline-drop-consequence');
    expect(chip).toHaveTextContent('a gate cannot hold work');
    expect(screen.getByTestId('outline-drop-indicator')).toHaveAttribute(
      'data-drop-tone',
      'refused',
    );
  });
});

describe('OutlineDropIndicator — a refusal is marked, never offered', () => {
  it('draws no insertion line for a refusal', () => {
    // A line is an offer. Drawing one over a row that will reject the drop is
    // the thing the whole preview exists to prevent.
    renderIndicator({ kind: 'refused', reason: 'own-subtree', targetId: 'a', level: 3 });
    expect(screen.queryByTestId('outline-drop-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('outline-drop-target-band')).toBeInTheDocument();
  });

  it('draws one for a drop that will land', () => {
    renderIndicator({ kind: 'child', targetId: 'phase', level: 2, becomesPhase: false });
    expect(screen.getByTestId('outline-drop-line')).toBeInTheDocument();
  });
});

describe('OutlineDropIndicator — sibling and child differ by position, not colour', () => {
  it('the child line sits one WBS_INDENT deeper than the sibling line', () => {
    const sibling = render(
      <OutlineDropIndicator
        intent={{
          kind: 'sibling',
          referenceId: 'gate',
          position: 'before',
          newParentId: null,
          level: 1,
        }}
        rows={ROWS}
        draggedId="a"
        rowHeight={ROW_H}
      />,
    );
    const siblingIndent = Number(
      sibling.getByTestId('outline-drop-line').getAttribute('data-indent'),
    );
    sibling.unmount();

    renderIndicator({ kind: 'child', targetId: 'gate', level: 2, becomesPhase: true });
    const childIndent = Number(
      screen.getByTestId('outline-drop-line').getAttribute('data-indent'),
    );

    expect(siblingIndent).toBe(outlineGuideX(1));
    expect(childIndent - siblingIndent).toBe(WBS_INDENT);
  });
});

describe('OutlineDropIndicator — it is decoration over a live list', () => {
  it('never intercepts a pointer and is never announced twice', () => {
    // Web rule 309(b) / the #2782 class: an overlay that forgets
    // pointer-events-none freezes everything beneath it. The claim reaches a
    // screen reader through the schedule's polite region, so a second copy here
    // would double-announce.
    renderIndicator({ kind: 'child', targetId: 'phase', level: 2, becomesPhase: false });
    const root = screen.getByTestId('outline-drop-indicator');
    expect(root.className).toContain('pointer-events-none');
    expect(root).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing for a position that changes nothing', () => {
    const { container } = renderIndicator({ kind: 'none' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the intent names a row that has gone', () => {
    const { container } = renderIndicator({
      kind: 'child',
      targetId: 'ghost',
      level: 2,
      becomesPhase: false,
    });
    expect(container).toBeEmptyDOMElement();
  });
});
