import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReadOnlyIndicator } from './ReadOnlyIndicator';

describe('ReadOnlyIndicator (ADR-0133)', () => {
  it('exposes subject, value, and provenance in one composite label ending in "View only."', () => {
    render(
      <ReadOnlyIndicator
        label="Slip policy"
        value="Warn only"
        provenance="managed by the program admin"
      />,
    );
    expect(
      screen.getByLabelText('Slip policy: Warn only, managed by the program admin. View only.'),
    ).toBeInTheDocument();
  });

  it('renders the value word visibly (state never conveyed by color alone, rule 7)', () => {
    render(<ReadOnlyIndicator label="Methodology" value="Agile" provenance="set by a Scheduler" />);
    expect(screen.getByText('Agile')).toBeInTheDocument();
    expect(screen.getByText('· set by a Scheduler')).toBeInTheDocument();
  });

  it('compact hides the visible provenance clause but keeps the full aria-label', () => {
    render(
      <ReadOnlyIndicator
        label="Program sync"
        value="On"
        provenance="managed by the program admin"
        compact
      />,
    );
    // Value word still visible...
    expect(screen.getByText('On')).toBeInTheDocument();
    // ...but the visible "· provenance" clause is gone.
    expect(screen.queryByText('· managed by the program admin')).toBeNull();
    // ...while the composite accessible name still carries it.
    expect(
      screen.getByLabelText('Program sync: On, managed by the program admin. View only.'),
    ).toBeInTheDocument();
  });

  it('does not render any disabled or focusable form control', () => {
    const { container } = render(
      <ReadOnlyIndicator label="Auto-escalate" value="On" provenance="managed by the program admin" />,
    );
    expect(container.querySelector('input, button, select, textarea, [disabled]')).toBeNull();
  });
});
