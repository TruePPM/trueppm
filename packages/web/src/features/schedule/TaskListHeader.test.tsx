/**
 * Keyboard operability for the task-list column resize handles (#2205,
 * WCAG 2.1.1). Each header ResizeHandle is a focusable `separator` exposing
 * aria-value*; arrows nudge width by 16px and Home/End jump to the min/max —
 * mirroring the panel splitter, so column widths are reachable without a mouse.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TaskListHeader } from './TaskListHeader';
import { MIN_COL_WIDTHS, type ColumnWidths } from '@/hooks/useColumnWidths';

const WIDTHS: ColumnWidths['widths'] = {
  wbs: 48,
  task: 220,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 56,
  owner: 60,
};

const VISIBLE: ColumnWidths['visible'] = {
  wbs: true,
  task: true,
  dur: true,
  start: true,
  finish: true,
  progress: true,
  owner: true,
};

function renderHeader(setWidth = vi.fn()) {
  render(<TaskListHeader widths={WIDTHS} visible={VISIBLE} setWidth={setWidth} />);
  return setWidth;
}

afterEach(cleanup);

describe('TaskListHeader column resize keyboard operability (#2205)', () => {
  it('exposes each handle as a focusable separator with aria-value*', () => {
    renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize task column' });
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-valuenow', '220');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_COL_WIDTHS.task));
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuetext', 'task column 220 pixels');
  });

  it('ArrowRight / ArrowLeft nudge the width by 16px', () => {
    const setWidth = renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize task column' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(setWidth).toHaveBeenLastCalledWith('task', 236);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(setWidth).toHaveBeenLastCalledWith('task', 204);
  });

  it('Home clamps to the column min; End jumps to the keyboard max', () => {
    const setWidth = renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize dur column' });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(setWidth).toHaveBeenLastCalledWith('dur', MIN_COL_WIDTHS.dur);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(setWidth).toHaveBeenLastCalledWith('dur', 400);
  });

  it('never nudges below the column min (clamped)', () => {
    const setWidth = vi.fn();
    render(
      <TaskListHeader
        widths={{ ...WIDTHS, dur: MIN_COL_WIDTHS.dur }}
        visible={VISIBLE}
        setWidth={setWidth}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize dur column' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    // Already at the floor — the clamp keeps it at the min, not below.
    expect(setWidth).toHaveBeenLastCalledWith('dur', MIN_COL_WIDTHS.dur);
  });
});
