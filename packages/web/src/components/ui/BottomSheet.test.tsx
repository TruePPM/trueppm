import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';

describe('<BottomSheet>', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <BottomSheet isOpen={false} onClose={vi.fn()} ariaLabel="Test">
        <p>hidden</p>
      </BottomSheet>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the dialog and the scrim when open', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test sheet">
        <p>visible</p>
      </BottomSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Test sheet' })).toBeInTheDocument();
    expect(screen.getByTestId('bottom-sheet-scrim')).toBeInTheDocument();
    expect(screen.getByText('visible')).toBeInTheDocument();
  });

  it('uses aria-labelledby when titleId is provided', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} titleId="heading-id">
        <h2 id="heading-id">My heading</h2>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'heading-id');
    expect(dialog).not.toHaveAttribute('aria-label');
  });

  it('fires onClose on scrim tap', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen onClose={onClose} ariaLabel="Test">
        <p>x</p>
      </BottomSheet>,
    );
    fireEvent.pointerDown(screen.getByTestId('bottom-sheet-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen onClose={onClose} ariaLabel="Test">
        <p>x</p>
      </BottomSheet>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClose on Escape when isOpen=false', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={false} onClose={onClose} ariaLabel="Test">
        <p>x</p>
      </BottomSheet>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the drag handle by default and hides it when hasDragHandle=false', () => {
    const { rerender } = render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test">
        <p>x</p>
      </BottomSheet>,
    );
    expect(screen.getByTestId('bottom-sheet-drag-handle')).toBeInTheDocument();

    rerender(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" hasDragHandle={false}>
        <p>x</p>
      </BottomSheet>,
    );
    expect(screen.queryByTestId('bottom-sheet-drag-handle')).not.toBeInTheDocument();
  });

  it('uses inset-0 / rounded-none classes when size="full"', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" size="full">
        <p>x</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('inset-0');
    expect(dialog.className).toContain('rounded-none');
  });

  it('size="auto" grows to content with max-h-[85vh]', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" size="auto">
        <p>x</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('max-h-[85vh]');
    expect(dialog.className).toContain('rounded-t-card');
  });

  it('size="large" fills to a fixed h-[85vh], distinct from auto (not a no-op)', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" size="large">
        <p>x</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('h-[85vh]');
    expect(dialog.className).not.toContain('max-h-[85vh]');
    expect(dialog.className).toContain('rounded-t-card');
  });

  it('moves focus to the first focusable descendant on open (WCAG 2.4.3, #1503)', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test">
        <button type="button">First action</button>
        <button type="button">Second action</button>
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First action' }));
  });

  it('falls back to focusing the dialog container when it has no focusable content', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test">
        <p>no focusables here</p>
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('preserves a caller autoFocus target instead of stealing focus to the first control', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test">
        <button type="button">First action</button>
        {/* Simulate a caller focusing its own field: the callback ref runs at
            commit, before the sheet's on-open passive effect. */}
        <input aria-label="Search" ref={(el) => el?.focus()} />
      </BottomSheet>,
    );
    // The sheet already contains the focused input, so the on-open focus move is
    // a no-op and the caller's intended target keeps focus.
    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
  });

  it('omits md:hidden when mobileOnly=false (renders across breakpoints)', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" mobileOnly={false}>
        <p>x</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).not.toContain('md:hidden');
  });
});
