import { render, screen, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PreviewOverlay } from './PreviewOverlay';
import { useDragStore } from '@/stores/dragStore';
import type { GanttScaleData } from '@/features/gantt/engine';
import type { DragPreviewResult } from '@/types';

// ---------------------------------------------------------------------------
// Minimal scale data — covers 2025, week zoom (12px/day)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const SCALES: GanttScaleData = {
  start: new Date('2025-01-01T00:00:00Z'),
  end: new Date('2026-01-01T00:00:00Z'),
  totalWidth: 365 * 12,
  zoomLevel: 'week',
  pxPerMs: 12 / DAY_MS,
};

// Task IDs in render order
const TASK_IDS = ['t1', 't2', 't3'];

// A non-critical preview bar for t1
const NORMAL_RESULT: DragPreviewResult = {
  taskId: 't1',
  earlyStart: '2025-01-06',
  earlyFinish: '2025-01-10',
  isCritical: false,
  deltaDays: 2,
};

// A critical preview bar for t2
const CRITICAL_RESULT: DragPreviewResult = {
  taskId: 't2',
  earlyStart: '2025-01-13',
  earlyFinish: '2025-01-17',
  isCritical: true,
  deltaDays: 5,
};

const INITIAL_STORE = {
  phase: 'idle' as const,
  draggedTaskId: null,
  previewResults: [],
  worstMilestone: null,
  overflowCount: 0,
  isKeyboardMode: false,
  keyboardDelta: 0,
  confirmedStart: null,
};

beforeEach(() => {
  useDragStore.setState(INITIAL_STORE);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PreviewOverlay', () => {
  describe('visibility', () => {
    it('renders nothing when phase is idle', () => {
      const { container } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when scales are null', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      const { container } = render(
        <PreviewOverlay scales={null} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders when phase is dragging with scales', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      // Container should be present (aria-hidden overlay)
      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    });

    it('renders when phase is committing (animate-out)', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      const { container } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      expect(container.firstChild).not.toBeNull();
    });
  });

  describe('pointer events and accessibility (rule 27)', () => {
    it('root element is pointer-events-none and aria-hidden', () => {
      useDragStore.getState().startDrag('t1');
      const { container } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      const overlay = container.firstChild as HTMLElement;
      expect(overlay).toHaveAttribute('aria-hidden', 'true');
      expect(overlay.className).toContain('pointer-events-none');
    });
  });

  describe('animate-out (rule 33)', () => {
    it('has opacity 1 when dragging', () => {
      useDragStore.getState().startDrag('t1');
      const { container } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      const overlay = container.firstChild as HTMLElement;
      expect(overlay.style.opacity).toBe('1');
    });

    it('transitions to opacity 0 when committing', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      const { container } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      const overlay = container.firstChild as HTMLElement;
      expect(overlay.style.opacity).toBe('0');
      expect(overlay.style.transition).toContain('opacity');
    });
  });

  describe('CP badge delay (rule 26)', () => {
    it('does not show CP badge immediately on mount', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(screen.queryByText('CP')).toBeNull();
    });

    it('shows CP badge after 400 ms', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText('CP')).toBeInTheDocument();
    });

    it('does not show CP badge at 399 ms', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      act(() => vi.advanceTimersByTime(399));
      expect(screen.queryByText('CP')).toBeNull();
    });

    it('hides CP badge when drag ends', () => {
      vi.useFakeTimers();
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([CRITICAL_RESULT], null, 0);
      const { rerender } = render(
        <PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />,
      );
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText('CP')).toBeInTheDocument();

      act(() => useDragStore.getState().cancelDrag());
      rerender(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      // Phase is idle → overlay not rendered → CP gone
      expect(screen.queryByText('CP')).toBeNull();
    });
  });

  describe('overflow label (rule 32)', () => {
    it('shows "+N more affected" when overflowCount > 0', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 7);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(screen.getByText('+7 more affected')).toBeInTheDocument();
    });

    it('hides the overflow label when overflowCount = 0', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().updatePreview([NORMAL_RESULT], null, 0);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(screen.queryByText(/more affected/)).toBeNull();
    });
  });

  describe('instruction strip (rules 28, 51)', () => {
    it('shows "Esc to cancel" for pointer drag', () => {
      useDragStore.getState().startDrag('t1'); // isKeyboard defaults to false
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(screen.getByText('Esc to cancel')).toBeInTheDocument();
    });

    it('shows keyboard legend when isKeyboardMode is true (rule 51)', () => {
      useDragStore.getState().startDrag('t1', true);
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(
        screen.getByText('← → Shift+arrow · d date · Enter confirm · Esc cancel'),
      ).toBeInTheDocument();
    });

    it('hides instruction strip when phase is committing', () => {
      useDragStore.getState().startDrag('t1');
      useDragStore.getState().commitDrag();
      render(<PreviewOverlay scales={SCALES} scrollLeft={0} taskIds={TASK_IDS} />);
      expect(screen.queryByText('Esc to cancel')).toBeNull();
    });
  });

  describe('origin ghost bar (rule 52)', () => {
    it('renders an origin bar in keyboard mode when originTask is provided', () => {
      useDragStore.getState().startDrag('t1', true);
      const originTask = { id: 't1', start: '2025-01-06', finish: '2025-01-10' };
      const { container } = render(
        <PreviewOverlay
          scales={SCALES}
          scrollLeft={0}
          taskIds={TASK_IDS}
          originTask={originTask}
        />,
      );
      // OriginBar uses a dashed border style (rule 52)
      const overlay = container.firstChild as HTMLElement;
      const dashedChild = Array.from(overlay.children).find((el) =>
        (el as HTMLElement).style?.borderStyle === 'dashed',
      );
      expect(dashedChild).toBeDefined();
    });

    it('does not render origin bar in pointer drag mode', () => {
      useDragStore.getState().startDrag('t1'); // pointer drag, isKeyboard = false
      const originTask = { id: 't1', start: '2025-01-06', finish: '2025-01-10' };
      const { container } = render(
        <PreviewOverlay
          scales={SCALES}
          scrollLeft={0}
          taskIds={TASK_IDS}
          originTask={originTask}
        />,
      );
      // No dashed-border child — origin bar is only shown in keyboard mode
      const overlay = container.firstChild as HTMLElement;
      const dashedChild = Array.from(overlay.children).find((el) =>
        (el as HTMLElement).style?.borderStyle === 'dashed',
      );
      expect(dashedChild).toBeUndefined();
    });
  });
});
