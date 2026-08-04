import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthorModePill } from './AuthorModePill';

describe('AuthorModePill (#2727, ADR-0776 §5)', () => {
  it('renders "Author" with an accessible label describing the switch when in author mode', () => {
    render(<AuthorModePill mode="author" onToggle={vi.fn()} />);
    const pill = screen.getByTestId('author-mode-pill');
    expect(pill).toHaveTextContent('Author');
    expect(pill).toHaveAccessibleName(/Author mode active.*switch to Read mode/i);
  });

  it('renders "Read" with an accessible label describing the switch when in read mode', () => {
    render(<AuthorModePill mode="read" onToggle={vi.fn()} />);
    const pill = screen.getByTestId('author-mode-pill');
    expect(pill).toHaveTextContent('Read');
    expect(pill).toHaveAccessibleName(/Read mode active.*switch to Author mode/i);
  });

  it('stays a fixed size in the flex-nowrap toolbar (matches BuildModePill, issue 1632)', () => {
    render(<AuthorModePill mode="author" onToggle={vi.fn()} />);
    const pill = screen.getByTestId('author-mode-pill');
    expect(pill.className).toMatch(/\bshrink-0\b/);
    expect(pill.className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('clicking calls onToggle', () => {
    const onToggle = vi.fn();
    render(<AuthorModePill mode="author" onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('author-mode-pill'));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
