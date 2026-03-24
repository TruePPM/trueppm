import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { formatShortDate } from './ganttUtils';
import { useDragStore } from '@/stores/dragStore';
import type { WorstMilestone } from '@/types';

const MILESTONE: WorstMilestone = {
  taskId: 'm1',
  name: 'Client Demo',
  baselineFinish: '2025-03-01',
  newFinish: '2025-03-04',
  deltaDays: 3,
};

beforeEach(() => {
  useDragStore.setState({
    phase: 'idle',
    draggedTaskId: null,
    previewResults: [],
    worstMilestone: null,
    overflowCount: 0,
    isKeyboardMode: false,
    keyboardDelta: 0,
    confirmedStart: null,
  });
});

function renderTooltip(milestoneLeft: number | null = 200, timelineTop = 100) {
  return render(
    <MilestoneDeltaTooltip milestoneLeft={milestoneLeft} timelineTop={timelineTop} />,
  );
}

describe('MilestoneDeltaTooltip', () => {
  it('renders nothing when phase is idle', () => {
    const { container } = renderTooltip();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when phase is dragging but worstMilestone is null', () => {
    useDragStore.getState().startDrag('t1');
    const { container } = renderTooltip();
    expect(container.firstChild).toBeNull();
  });

  it('renders the milestone name when dragging with a worst milestone', () => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    renderTooltip();
    expect(screen.getByText('Client Demo')).toBeInTheDocument();
  });

  it('shows the baseline and new finish dates', () => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    renderTooltip();
    // Use formatShortDate to stay timezone-independent
    expect(screen.getByText(formatShortDate(MILESTONE.baselineFinish))).toBeInTheDocument();
    expect(screen.getByText(formatShortDate(MILESTONE.newFinish))).toBeInTheDocument();
  });

  it('shows a positive delta label ("+3d") for a slipping milestone', () => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    renderTooltip();
    expect(screen.getByText('+3d')).toBeInTheDocument();
  });

  it('shows "On schedule" when deltaDays = 0', () => {
    const onSchedule: WorstMilestone = { ...MILESTONE, deltaDays: 0, newFinish: '2025-03-01' };
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], onSchedule, 0);
    renderTooltip();
    expect(screen.getByText('On schedule')).toBeInTheDocument();
  });

  it('shows a negative delta label ("-2d") when milestone moves earlier', () => {
    const earlier: WorstMilestone = {
      ...MILESTONE,
      deltaDays: -2,
      newFinish: '2025-02-27',
    };
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], earlier, 0);
    renderTooltip();
    expect(screen.getByText('-2d')).toBeInTheDocument();
  });

  it('is aria-hidden (informational overlay, not interactive)', () => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    renderTooltip();
    const container = screen.getByText('Client Demo').closest('[aria-hidden]');
    expect(container).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing once the drag phase moves to committing', () => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    useDragStore.getState().commitDrag();
    const { container } = renderTooltip();
    expect(container.firstChild).toBeNull();
  });
});
