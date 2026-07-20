import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FibonacciCardRow } from './FibonacciCardRow';

describe('FibonacciCardRow', () => {
  it('renders a radiogroup with a card per Fibonacci value plus the unsure card', () => {
    render(<FibonacciCardRow value={undefined} onSelect={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Your estimate' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1 points' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '13 points' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Unsure' })).toBeInTheDocument();
  });

  it('marks the selected card aria-checked and roving-tabbable', () => {
    render(<FibonacciCardRow value={5} onSelect={vi.fn()} />);
    const selected = screen.getByRole('radio', { name: '5 points' });
    expect(selected).toHaveAttribute('aria-checked', 'true');
    expect(selected).toHaveAttribute('tabindex', '0');
    // A non-selected card is not tabbable (roving tabindex).
    expect(screen.getByRole('radio', { name: '1 points' })).toHaveAttribute('tabindex', '-1');
  });

  // #2195: arrow keys move focus ONLY — they never commit a vote (web-rule 167).
  // Committing on every arrow press records a throwaway server vote per keystroke.
  it('ArrowRight moves focus to the next card WITHOUT calling onSelect', () => {
    const onSelect = vi.fn();
    render(<FibonacciCardRow value={1} onSelect={onSelect} />);
    const first = screen.getByRole('radio', { name: '1 points' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: '2 points' })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowLeft wraps focus from the first card to the unsure card WITHOUT calling onSelect', () => {
    const onSelect = vi.fn();
    render(<FibonacciCardRow value={1} onSelect={onSelect} />);
    const first = screen.getByRole('radio', { name: '1 points' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Unsure' })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowDown / ArrowUp also move focus only', () => {
    const onSelect = vi.fn();
    render(<FibonacciCardRow value={2} onSelect={onSelect} />);
    const second = screen.getByRole('radio', { name: '2 points' });
    second.focus();
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: '3 points' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: '3 points' }), { key: 'ArrowUp' });
    expect(screen.getByRole('radio', { name: '2 points' })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Activation is the ONLY commit path. Enter/Space fire a native button click,
  // so onClick -> onSelect covers keyboard activation without extra handling.
  it('clicking a card commits that vote via onSelect', () => {
    const onSelect = vi.fn();
    render(<FibonacciCardRow value={undefined} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('radio', { name: '8 points' }));
    expect(onSelect).toHaveBeenCalledWith(8);
  });

  it('clicking the unsure card commits a null vote', () => {
    const onSelect = vi.fn();
    render(<FibonacciCardRow value={undefined} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Unsure' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('disables every card when disabled', () => {
    render(<FibonacciCardRow value={undefined} onSelect={vi.fn()} disabled />);
    for (const card of screen.getAllByRole('radio')) {
      expect(card).toBeDisabled();
    }
  });
});
