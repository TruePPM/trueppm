/**
 * WipLimitConfirmDialog unit tests (#232, #2050).
 *
 * Replaces a native window.confirm fired mid-drop. Verifies the prompt names the
 * column and its breached limit, that confirm/cancel fire exactly once, that
 * Escape cancels (keyboard exit == visual exit), and that the safe action is
 * focused first (Cancel-first, rule 245) so a fast Enter never blows past a WIP
 * limit.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WipLimitConfirmDialog } from './WipLimitConfirmDialog';

function renderDialog(overrides: Partial<Parameters<typeof WipLimitConfirmDialog>[0]> = {}) {
  const props = {
    taskName: 'Draft FAT plan',
    columnLabel: 'In Progress',
    count: 2,
    limit: 1,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<WipLimitConfirmDialog {...props} />);
  return props;
}

describe('WipLimitConfirmDialog', () => {
  it('names the task, column, and breached limit', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: /Move past the WIP limit/i });
    expect(dialog).toHaveTextContent(/In Progress/);
    expect(dialog).toHaveTextContent(/at or over its WIP limit \(2\/1\)/i);
    expect(dialog).toHaveTextContent(/Draft FAT plan/);
  });

  it('fires onConfirm when "Move anyway" is clicked', () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when "Keep it here" is clicked', () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Keep it here/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when Escape is pressed', () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('focuses the safe "Keep it here" action on mount (Cancel-first, rule 245)', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Keep it here/i }));
  });
});
