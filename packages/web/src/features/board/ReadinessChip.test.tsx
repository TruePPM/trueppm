import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadinessChip } from './ReadinessChip';

describe('ReadinessChip', () => {
  it('renders the label text for each readiness state', () => {
    const { rerender } = render(<ReadinessChip readiness="idea" />);
    expect(screen.getByText('idea')).toBeInTheDocument();

    rerender(<ReadinessChip readiness="estimated" />);
    expect(screen.getByText('estimated')).toBeInTheDocument();

    rerender(<ReadinessChip readiness="ready" />);
    expect(screen.getByText('ready')).toBeInTheDocument();

    rerender(<ReadinessChip readiness="baselined" />);
    expect(screen.getByText('baselined')).toBeInTheDocument();
  });

  it('renders the glyph as decorative (aria-hidden) so the text carries the signal', () => {
    render(<ReadinessChip readiness="ready" />);
    // The ⛓ glyph is aria-hidden; "ready" is the accessible signal (web-rule 107).
    const chip = screen.getByText('ready');
    expect(chip.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  describe('compact variant', () => {
    it('renders the label for each state (uppercased via CSS)', () => {
      const { rerender } = render(<ReadinessChip readiness="idea" variant="compact" />);
      // The DOM text stays lowercase — the uppercase is a `text-transform` class,
      // so the accessible name is still the plain state word.
      expect(screen.getByText('idea')).toBeInTheDocument();

      rerender(<ReadinessChip readiness="baselined" variant="compact" />);
      expect(screen.getByText('baselined')).toBeInTheDocument();
    });

    it('applies the brand-primary-light inline background only for the ready state', () => {
      const { rerender } = render(<ReadinessChip readiness="ready" variant="compact" />);
      expect(screen.getByText('ready').style.backgroundColor).toBe('rgb(var(--brand-primary-light))');

      rerender(<ReadinessChip readiness="idea" variant="compact" />);
      expect(screen.getByText('idea').style.backgroundColor).toBe('');
    });
  });
});
