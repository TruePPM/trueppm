import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RiskChip } from './RiskChip';

describe('RiskChip', () => {
  it('maps severity bands to their canonical labels (rule 86)', () => {
    const cases: Array<[number, string]> = [
      [25, 'Critical'],
      [12, 'High'],
      [8, 'Medium'],
      [3, 'Low'],
      [1, 'Minimal'],
    ];
    for (const [severity, label] of cases) {
      const { unmount } = render(<RiskChip severity={severity} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  // #2197 — the HIGH chip's amber text must be the readable `brand-accent-text`
  // (#92400E, ≥6:1 on the accent-light tint), NOT the fill-weight
  // `brand-accent-dark` (#C17A10), which is only 3.13:1 as text and failed WCAG
  // 1.4.3. It must also carry the rule-86 dark override.
  it('renders the HIGH chip with the readable amber text token, never the failing fill weight', () => {
    render(<RiskChip severity={15} />);
    const chip = screen.getByText('High');
    expect(chip.className).toContain('text-brand-accent-text');
    expect(chip.className).not.toContain('text-brand-accent-dark');
    // rule-86 dark alternates so the static #FFF3CD tint doesn't flash on dark
    expect(chip.className).toContain('dark:text-brand-accent');
    expect(chip.className).toContain('dark:bg-brand-accent/20');
  });

  it('uses the semantic critical tokens for the CRITICAL chip', () => {
    render(<RiskChip severity={22} />);
    const chip = screen.getByText('Critical');
    expect(chip.className).toContain('text-semantic-critical');
    expect(chip.className).toContain('bg-semantic-critical-bg');
  });

  it('appends the score when showScore is set', () => {
    render(<RiskChip severity={16} showScore />);
    expect(screen.getByText('High · 16')).toBeInTheDocument();
  });
});
