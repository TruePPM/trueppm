// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FloatHelp } from './FloatHelp';
import { BaselineVarianceHelp } from './BaselineVarianceHelp';
import { GuardrailBreachHelp } from './sections/GuardrailBreachHelp';
import { UtilizationHelp } from '../resource/UtilizationHelp';
import { VelocityHelp } from '../sprints/VelocityHelp';

/**
 * #3714 — contextual help on the read surfaces. Each trigger must expose its
 * subject as an accessible name, open a named dialog on activation, and link
 * into a docs page that exists.
 */
const CASES = [
  { name: 'FloatHelp', node: <FloatHelp />, label: 'Total float and free float', text: /working days/i, doc: 'features/schedule/' },
  { name: 'BaselineVarianceHelp', node: <BaselineVarianceHelp />, label: 'Baseline variance', text: /active baseline/i, doc: 'features/baselines/' },
  { name: 'UtilizationHelp', node: <UtilizationHelp />, label: 'Utilization', text: /resource assignments/i, doc: 'features/resources/' },
  { name: 'VelocityHelp', node: <VelocityHelp />, label: 'Velocity', text: /closed sprints only/i, doc: 'features/velocity/' },
  { name: 'GuardrailBreachHelp', node: <GuardrailBreachHelp />, label: 'Sprint guardrails', text: /sprint-composition rule/i, doc: 'administration/project-settings/' },
];

describe.each(CASES)('$name', ({ node, label, text, doc }) => {
  it('opens a labelled dialog from a named trigger and deep-links to docs', async () => {
    const user = userEvent.setup();
    renderWithProviders(node);
    const trigger = screen.getByRole('button', { name: `About the ${label} options` });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: label });
    expect(dialog).toHaveTextContent(text);
    expect(screen.getByRole('link', { name: /opens in a new tab/i })).toHaveAttribute(
      'href',
      expect.stringContaining(doc),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
