import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { vi } from 'vitest';
import { describe, it, expect, beforeEach } from 'vitest';
import { MilestoneDeltaAnchor, MilestoneDeltaTooltip } from './MilestoneDeltaTooltip';
import { useElementRef } from '@/hooks/useElementRef';
import type { GanttScaleData } from './engine';

vi.mock('./engine', () => ({
  milestoneX: (_iso: string, atDayEnd: boolean | undefined) => (atDayEnd ? 700 : 500),
}));
import { formatShortDate } from './scheduleUtils';
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
  return render(<MilestoneDeltaTooltip milestoneLeft={milestoneLeft} timelineTop={timelineTop} />);
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

describe('MilestoneDeltaAnchor (#2189)', () => {
  // The container mounts AFTER the first commit (a skeleton renders first), the
  // case a pre-seeded `{ current: el }` would hide (web rule 279).
  function Harness({ mounted }: { mounted: boolean }) {
    const { el, setEl } = useElementRef<HTMLDivElement>();
    const [scroll] = useState({ current: { scrollLeft: 100 } as unknown as HTMLElement });
    return (
      <>
        {mounted && <div ref={setEl} data-testid="container" />}
        <MilestoneDeltaAnchor
          timelineEl={el}
          canvasScrollRef={scroll}
          panelWidth={300}
          scales={{} as GanttScaleData}
        />
      </>
    );
  }

  it('anchors to the worst milestone once the container mounts after the first commit', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 77,
    } as DOMRect);
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    const { rerender } = render(<Harness mounted={false} />);
    const card = () => screen.getByText('Client Demo').closest('.fixed') as HTMLElement;
    // Before the container exists: the fixed fallback.
    expect(card().style.left).toBe('120px');

    act(() => {
      rerender(<Harness mounted />);
    });
    // 10 (container) + 300 (panel) + 500 (dateToLeft) - 100 (scroll) - 80 (centering).
    expect(card().style.left).toBe('630px');
    expect(card().style.top).toBe('85px');
  });
  it('aligns to the end of the day for an end-of-day milestone (#4079)', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 77,
    } as DOMRect);
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview(
      [
        {
          taskId: 'm1',
          earlyStart: '2025-03-04',
          earlyFinish: '2025-03-04',
          isCritical: false,
          deltaDays: 3,
          milestoneAtDayEnd: true,
        },
      ],
      MILESTONE,
      0,
    );
    render(<Harness mounted />);
    // 10 + 300 + 700 (day end) - 100 (scroll) - 80.
    expect((screen.getByText('Client Demo').closest('.fixed') as HTMLElement).style.left).toBe(
      '830px',
    );
  });

  it('never sits over the task-list panel', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 77,
    } as DOMRect);
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
    const scroll = { current: { scrollLeft: 5000 } as unknown as HTMLElement };
    function Far() {
      const { el, setEl } = useElementRef<HTMLDivElement>();
      return (
        <>
          <div ref={setEl} />
          <MilestoneDeltaAnchor
            timelineEl={el}
            canvasScrollRef={scroll}
            panelWidth={300}
            scales={{} as GanttScaleData}
          />
        </>
      );
    }
    render(<Far />);
    // Scrolled far left: raw is negative; floor is container (10) + panel (300) + 8.
    expect((screen.getByText('Client Demo').closest('.fixed') as HTMLElement).style.left).toBe(
      '318px',
    );
  });
});

describe('MilestoneDeltaTooltip viewport clamping', () => {
  const card = () => screen.getByText('Client Demo').closest('.fixed') as HTMLElement;
  beforeEach(() => {
    useDragStore.getState().startDrag('t1');
    useDragStore.getState().updatePreview([], MILESTONE, 0);
  });

  it('clamps the right edge so the card stays inside the viewport', () => {
    renderTooltip(window.innerWidth + 500);
    expect(card().style.left).toBe(`${window.innerWidth - 176 - 8}px`);
  });

  it('clamps the left edge to the viewport margin', () => {
    renderTooltip(0);
    expect(card().style.left).toBe('8px');
  });

  it('falls back to the fixed position when the anchor is NaN', () => {
    renderTooltip(Number.NaN);
    expect(card().style.left).toBe('120px');
  });
});
