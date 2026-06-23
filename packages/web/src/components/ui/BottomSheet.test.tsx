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

  it('uses bottom-0 / max-h-[85vh] / rounded-t-card when size="auto" or "large"', () => {
    const { rerender } = render(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" size="auto">
        <p>x</p>
      </BottomSheet>,
    );
    let dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('max-h-[85vh]');
    expect(dialog.className).toContain('rounded-t-card');

    rerender(
      <BottomSheet isOpen onClose={vi.fn()} ariaLabel="Test" size="large">
        <p>x</p>
      </BottomSheet>,
    );
    dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('bottom-0');
    expect(dialog.className).toContain('max-h-[85vh]');
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
