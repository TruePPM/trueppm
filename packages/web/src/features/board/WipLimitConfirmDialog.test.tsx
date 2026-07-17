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

  it('paints the brand-primary button with navy-on-sage ink, not white (#2041, WCAG 1.4.3)', () => {
    // In dark mode --brand-primary flips to sage-400 (#66B998); white text on it
    // is ≈2.3:1 — a WCAG 1.4.3 failure. Rule 144's sanctioned recipe pairs the
    // sage fill with --neutral-text-inverse, which is near-black in dark mode
    // (navy-on-sage) and white in light mode (zero visual change). This locks the
    // fill in place while forbidding the old white-on-sage pairing.
    renderDialog();
    const brandButton = screen.getByRole('button', { name: /Keep it here/i });
    expect(brandButton.className).toContain('bg-brand-primary');
    expect(brandButton.className).toContain('text-neutral-text-inverse');
    expect(brandButton.className).not.toContain('text-white');
  });
});
