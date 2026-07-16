import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmDeleteStrip } from './ConfirmDeleteStrip';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConfirmDeleteStrip', () => {
  it('focuses the Confirm button on mount', () => {
    render(
      <ConfirmDeleteStrip count={2} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /confirm delete/i })).toHaveFocus();
  });

  it('singular noun for count of 1', () => {
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Delete 1 task\?/)).toBeInTheDocument();
  });

  it('plural noun for count > 1', () => {
    render(
      <ConfirmDeleteStrip count={3} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Delete 3 tasks\?/)).toBeInTheDocument();
  });

  it('warns that bulk delete cannot be undone (#2029)', () => {
    render(
      <ConfirmDeleteStrip count={3} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/can’t be undone/i)).toBeInTheDocument();
  });

  it('shows the deleting state and disables both buttons', () => {
    render(
      <ConfirmDeleteStrip count={2} isDeleting={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /deleting…/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
  });

  it('clicking Confirm invokes onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('clicking Cancel invokes onCancel', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('auto-cancels after 5 seconds when not deleting', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('does NOT auto-cancel while deleting is in flight', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={true} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
