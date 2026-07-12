import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingAcceptanceChip, pendingAcceptanceExplainer } from './PendingAcceptanceChip';

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

describe('pendingAcceptanceExplainer (#1472)', () => {
  it('is role-neutral — names the outcome, never a specific role', () => {
    const text = pendingAcceptanceExplainer('sprint');
    expect(text).toContain('someone on the team accepts it');
    // Never name a specific facet-holder role (wrong on a PO-run board).
    expect(text).not.toMatch(/scrum master|product owner/i);
    // Outcome language only — never state-machine jargon.
    expect(text).not.toMatch(/scope injection/i);
  });

  it('honors the configured iteration-container noun', () => {
    expect(pendingAcceptanceExplainer('iteration')).toContain('after the iteration started');
    // Defaults to "sprint" for cross-project surfaces with no single label.
    expect(pendingAcceptanceExplainer()).toContain('after the sprint started');
  });
});

describe('PendingAcceptanceChip interactive disclosure (#1472)', () => {
  const EXPLAINER = pendingAcceptanceExplainer('sprint');

  it('stays passive (no button) when no explainer is supplied', () => {
    render(<PendingAcceptanceChip />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a disclosure trigger — collapsed by default — when given an explainer', () => {
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    const trigger = screen.getByRole('button', { name: /pending acceptance/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Explanation is not in the DOM until opened.
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('opens the explainer on tap and shows the plain-language sentence', async () => {
    const user = userEvent.setup();
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    await user.click(screen.getByRole('button', { name: /pending acceptance/i }));
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(EXPLAINER);
    expect(screen.getByRole('button', { name: /pending acceptance/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('grants NO accept/reject controls — only an explain trigger + a Got it close', async () => {
    const user = userEvent.setup();
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    await user.click(screen.getByRole('button', { name: /pending acceptance/i }));
    // The only two buttons are the disclosure trigger and "Got it" — the chip
    // never renders an accept/reject/decline control (no capability granted).
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject|decline/i })).not.toBeInTheDocument();
  });

  it('closes on "Got it" and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    const trigger = screen.getByRole('button', { name: /pending acceptance/i });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    const trigger = screen.getByRole('button', { name: /pending acceptance/i });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not open or drag/select the card — click stops propagation', async () => {
    const user = userEvent.setup();
    const onParentClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={onParentClick}>
        <PendingAcceptanceChip explainer={EXPLAINER} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /pending acceptance/i }));
    // Opening the explainer must not bubble to the card-click handler.
    expect(onParentClick).not.toHaveBeenCalled();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('keeps the neutral surface on the interactive trigger (rule 149)', () => {
    render(<PendingAcceptanceChip explainer={EXPLAINER} />);
    const trigger = screen.getByRole('button', { name: /pending acceptance/i });
    expect(trigger.className).toContain('bg-neutral-surface-sunken');
    expect(trigger.className).not.toContain('semantic-at-risk');
    expect(trigger.className).not.toContain('semantic-critical');
  });
});
