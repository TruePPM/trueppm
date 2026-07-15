import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FieldHelp, type FieldHelpOption } from './FieldHelp';

const GOVERNANCE: FieldHelpOption[] = [
  { label: 'Flow', desc: 'Agile, sprint- or kanban-governed work (default).', selected: true },
  { label: 'Gated', desc: 'Phase-gate–governed waterfall work.' },
  { label: 'Hybrid', desc: 'Mixes flow and gated within the subtree.' },
];

function renderGovernance() {
  return render(
    <FieldHelp
      label="Governance class"
      intro="Which overlay governs this task's subtree."
      options={GOVERNANCE}
      docHref="features/task-classification/#governance-class--which-overlay-governs-the-subtree"
    />,
  );
}

describe('FieldHelp', () => {
  it('renders a collapsed, labelled trigger and no popover initially', () => {
    renderGovernance();
    const trigger = screen.getByRole('button', { name: 'About the Governance class options' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on click, lists every option, and marks the current one', async () => {
    const user = userEvent.setup();
    renderGovernance();
    await user.click(screen.getByRole('button', { name: 'About the Governance class options' }));

    const dialog = screen.getByRole('dialog', { name: 'Governance class' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(within(dialog).getByText("Which overlay governs this task's subtree.")).toBeInTheDocument();

    // All three options + their descriptions are visible at once.
    for (const o of GOVERNANCE) {
      expect(within(dialog).getByText(o.label)).toBeInTheDocument();
      expect(within(dialog).getByText(o.desc)).toBeInTheDocument();
    }

    // The selected row is marked non-color-only: a "Current" label + aria-current.
    expect(within(dialog).getByText('Current')).toBeInTheDocument();
    const currentRow = within(dialog).getByText('Flow').closest('li');
    expect(currentRow).toHaveAttribute('aria-current', 'true');
  });

  it('exposes a docs deep-link that opens in a new tab', async () => {
    const user = userEvent.setup();
    renderGovernance();
    await user.click(screen.getByRole('button', { name: 'About the Governance class options' }));

    const link = screen.getByRole('link', { name: /learn more/i });
    expect(link).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/features/task-classification/#governance-class--which-overlay-governs-the-subtree',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('toggles aria-expanded / aria-controls with open state', async () => {
    const user = userEvent.setup();
    renderGovernance();
    const trigger = screen.getByRole('button', { name: 'About the Governance class options' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog');
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
    // Click again closes.
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderGovernance();
    const trigger = screen.getByRole('button', { name: 'About the Governance class options' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on the "Got it" button', async () => {
    const user = userEvent.setup();
    renderGovernance();
    await user.click(screen.getByRole('button', { name: 'About the Governance class options' }));
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders free-form body content when no options are given', async () => {
    const user = userEvent.setup();
    render(
      <FieldHelp label="Effort" body={<span>Estimated person-days.</span>} docHref="features/effort/" />,
    );
    await user.click(screen.getByRole('button', { name: 'About the Effort options' }));
    const dialog = screen.getByRole('dialog', { name: 'Effort' });
    expect(within(dialog).getByText('Estimated person-days.')).toBeInTheDocument();
  });
});
