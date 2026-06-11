import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { ScheduleCommitPopover, type CommitAction } from './ScheduleCommitPopover';

function makeRescheduleAction(
  overrides: Partial<Extract<CommitAction, { kind: 'reschedule' }>> = {},
): CommitAction {
  return {
    kind: 'reschedule',
    oldStartIso: '2026-05-17',
    newStartIso: '2026-06-05',
    ...overrides,
  };
}

function makeResizeAction(
  overrides: Partial<Extract<CommitAction, { kind: 'resize' }>> = {},
): CommitAction {
  return {
    kind: 'resize',
    oldDurationDays: 14,
    newDurationDays: 21,
    ...overrides,
  };
}

function renderPopover(
  props: Partial<ComponentProps<typeof ScheduleCommitPopover>> = {},
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onDismissByOutsideClick = vi.fn();
  const utils = render(
    <ScheduleCommitPopover
      anchor={{ x: 500, y: 300 }}
      activeSprintName={null}
      action={makeRescheduleAction()}
      isPending={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onDismissByOutsideClick={onDismissByOutsideClick}
      {...props}
    />,
  );
  return { ...utils, onConfirm, onCancel, onDismissByOutsideClick };
}

describe('ScheduleCommitPopover', () => {
  beforeEach(() => {
    // Stable viewport for layout math.
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  });

  it('renders the Reschedule title and date range for drag actions', () => {
    renderPopover();
    expect(screen.getByText('Reschedule task?')).toBeInTheDocument();
    expect(screen.getByText('May 17 → Jun 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('renders the Resize title and duration range for resize actions', () => {
    renderPopover({ action: makeResizeAction() });
    expect(screen.getByText('Resize task?')).toBeInTheDocument();
    expect(screen.getByText('14d → 21d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize' })).toBeInTheDocument();
  });

  it('shows the active-sprint notice when activeSprintName is non-null', () => {
    renderPopover({ activeSprintName: 'Q2 2026' });
    const notice = screen.getByTestId('commit-popover-active-sprint-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('Committed in Sprint');
    expect(notice).toHaveTextContent('Q2 2026');
  });

  it('hides the active-sprint notice when activeSprintName is null', () => {
    renderPopover({ activeSprintName: null });
    expect(screen.queryByTestId('commit-popover-active-sprint-notice')).toBeNull();
  });

  it('initial focus lands on the Confirm button', () => {
    renderPopover({ action: makeRescheduleAction() });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reschedule' }));
  });

  it('Enter (with focus inside the popover) fires onConfirm', () => {
    const { onConfirm } = renderPopover();
    const confirm = screen.getByRole('button', { name: 'Reschedule' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Esc fires onCancel regardless of focus location', () => {
    const { onCancel } = renderPopover();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking the Cancel button fires onCancel', () => {
    const { onCancel } = renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking the Confirm button fires onConfirm', () => {
    const { onConfirm } = renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('mousedown outside the popover fires onDismissByOutsideClick', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const { onDismissByOutsideClick } = renderPopover();
    fireEvent.mouseDown(outside);
    expect(onDismissByOutsideClick).toHaveBeenCalledTimes(1);
    document.body.removeChild(outside);
  });

  it('disables both buttons and shows "Saving…" while isPending is true', () => {
    renderPopover({ isPending: true });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(cancel).toBeDisabled();
    expect(saving).toBeDisabled();
  });

  it('does not call onConfirm on Enter while isPending', () => {
    const { onConfirm } = renderPopover({ isPending: true });
    const saving = screen.getByRole('button', { name: 'Saving…' });
    saving.focus();
    fireEvent.keyDown(saving, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders an inline error and switches Confirm to "Retry" when error is set', () => {
    renderPopover({ error: "Couldn't save the change. Try again or cancel." });
    expect(screen.getByTestId('commit-popover-error')).toHaveTextContent(
      "Couldn't save the change.",
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('uses role="dialog" with the title and change rows wired via aria attributes', () => {
    renderPopover();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'schedule-commit-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'schedule-commit-change');
  });

  it('Confirm button uses the navy-on-sage Button recipe, not white-on-sage (#1025, WCAG 1.4.3)', () => {
    // The dark schedule canvas (rule 40) flips brand-primary to sage-400; the
    // old `bg-brand-primary text-white` rendered white-on-sage-400 ≈ 1.8:1.
    // The shared Button (variant="primary") puts navy ink on the sage fill in
    // both modes (navy-on-sage ≈ 6.8:1).
    renderPopover();
    const confirm = screen.getByRole('button', { name: 'Reschedule' });
    expect(confirm.className).toContain('text-navy-900');
    expect(confirm.className).toContain('dark:bg-sage-400');
    expect(confirm.className).not.toContain('text-white');
  });

  it('Tab from Confirm focuses Cancel (focus trap)', () => {
    renderPopover();
    const confirm = screen.getByRole('button', { name: 'Reschedule' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    confirm.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });
});
