/**
 * KeyboardCheatsheet — renders all shortcut sections and handles close interactions.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KeyboardCheatsheet } from './KeyboardCheatsheet';

describe('KeyboardCheatsheet', () => {
  it('renders the dialog with accessible role and label', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('renders the close button', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close shortcuts' })).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<KeyboardCheatsheet onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close shortcuts' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is pointer-downed', () => {
    const onClose = vi.fn();
    render(<KeyboardCheatsheet onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when inner content is pointer-downed', () => {
    const onClose = vi.fn();
    render(<KeyboardCheatsheet onClose={onClose} />);
    // Click on the title — it is inside the inner div that stops propagation
    fireEvent.pointerDown(screen.getByText('Keyboard shortcuts'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders all four section headings', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Lanes')).toBeInTheDocument();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('renders shortcut keys as kbd elements', () => {
    const { container } = render(<KeyboardCheatsheet onClose={vi.fn()} />);
    const kbds = container.querySelectorAll('kbd');
    expect(kbds.length).toBeGreaterThan(0);
  });

  it('renders the J shortcut description', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByText('Next card in column')).toBeInTheDocument();
  });

  it('renders the Enter shortcut description', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByText('Open card detail')).toBeInTheDocument();
  });

  it('renders the ? shortcut description', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByText('Show this cheatsheet')).toBeInTheDocument();
  });

  // #2194 — the cheatsheet must not advertise dead shortcuts: Space-to-drag never
  // worked (onKeyDown is overridden) and there is no "Show comments" handler.
  it('does not advertise the dead keyboard-drag or comments shortcuts', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.queryByText(/pick up card to drag/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Show comments')).not.toBeInTheDocument();
  });

  it('documents the real keyboard path to move a card (the card actions menu)', () => {
    render(<KeyboardCheatsheet onClose={vi.fn()} />);
    expect(screen.getByText(/move card between columns/i)).toBeInTheDocument();
  });
});
