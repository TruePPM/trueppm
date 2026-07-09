import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AvatarInitials } from './AvatarInitials';

describe('AvatarInitials', () => {
  it('renders the provided initials', () => {
    render(<AvatarInitials initials="AL" />);
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('applies the rule-143 navy-on-sage treatment (guards against drift back to sage-on-sage)', () => {
    render(<AvatarInitials initials="AL" />);
    const el = screen.getByText('AL');
    // Navy text on a sage fill — AA on light and dark. The old sage-on-sage
    // (`text-brand-primary`) treatment failed AA on darker surfaces (#1705).
    expect(el).toHaveClass('bg-brand-primary/15');
    expect(el).toHaveClass('text-neutral-text-primary');
    expect(el).not.toHaveClass('text-brand-primary');
    expect(el).toHaveClass('rounded-full');
  });

  it('is decorative (aria-hidden) — the adjacent name is the accessible label', () => {
    render(<AvatarInitials initials="AL" />);
    expect(screen.getByText('AL')).toHaveAttribute('aria-hidden', 'true');
  });

  it('maps size to the circle dimensions and defaults to lg', () => {
    const { rerender } = render(<AvatarInitials initials="AL" size="sm" />);
    expect(screen.getByText('AL')).toHaveClass('h-6', 'w-6');

    rerender(<AvatarInitials initials="AL" size="md" />);
    expect(screen.getByText('AL')).toHaveClass('h-7', 'w-7');

    rerender(<AvatarInitials initials="AL" />);
    expect(screen.getByText('AL')).toHaveClass('h-8', 'w-8');
  });

  it('merges caller className onto the circle', () => {
    render(<AvatarInitials initials="AL" className="mt-0.5" />);
    expect(screen.getByText('AL')).toHaveClass('mt-0.5');
  });

  it('sets a native tooltip when title is provided', () => {
    render(<AvatarInitials initials="AL" title="Alice Lin" />);
    expect(screen.getByText('AL')).toHaveAttribute('title', 'Alice Lin');
  });
});
