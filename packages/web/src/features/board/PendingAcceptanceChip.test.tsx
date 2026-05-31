import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingAcceptanceChip } from './PendingAcceptanceChip';

describe('PendingAcceptanceChip (ADR-0102 §6)', () => {
  it('renders the neutral read-state label with outcome language', () => {
    render(<PendingAcceptanceChip />);
    const chip = screen.getByText('Pending acceptance');
    expect(chip).toBeInTheDocument();
    // Outcome language only — never the words "scope injection" / state-machine jargon.
    expect(screen.queryByText(/scope injection/i)).not.toBeInTheDocument();
  });

  it('uses the neutral surface token, never amber/red (rule 149)', () => {
    const { container } = render(<PendingAcceptanceChip />);
    const chip = container.firstElementChild as HTMLElement;
    // Neutral read-state — must carry the sunken/neutral classes and NOT a
    // semantic warning/critical token.
    expect(chip.className).toContain('bg-neutral-surface-sunken');
    expect(chip.className).toContain('text-neutral-text-secondary');
    expect(chip.className).not.toContain('semantic-at-risk');
    expect(chip.className).not.toContain('semantic-critical');
  });

  it('carries an accessible name even in compact mode (no visible label)', () => {
    render(<PendingAcceptanceChip compact />);
    // Compact drops the text but keeps the a11y name + glyph.
    expect(screen.queryByText('Pending acceptance')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Pending acceptance')).toBeInTheDocument();
  });

  it('renders no accept/reject controls — it is a passive label', () => {
    render(<PendingAcceptanceChip />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
