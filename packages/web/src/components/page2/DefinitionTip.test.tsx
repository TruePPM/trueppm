import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DefinitionTip } from './DefinitionTip';

const DEF = 'Working days a task can slip before it moves the finish.';

describe('DefinitionTip (rule 439)', () => {
  it('opens on hover', async () => {
    const user = userEvent.setup();
    render(<DefinitionTip term="Float" definition={DEF} />);
    await user.hover(screen.getByRole('button', { name: 'Float' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(DEF);
  });

  it('opens on keyboard focus and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<DefinitionTip term="Float" definition={DEF} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Float' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens on a tap', () => {
    render(<DefinitionTip term="Float" definition={DEF} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Float' }), { pointerType: 'touch' });
    expect(screen.getByRole('tooltip')).toHaveTextContent(DEF);
  });

  it('wears the dotted underline and the offset focus ring', () => {
    render(<DefinitionTip term="Float" definition={DEF} />);
    const btn = screen.getByRole('button', { name: 'Float' });
    expect(btn).toHaveClass('border-dotted', 'focus-visible:ring-2', 'focus-visible:ring-offset-2');
  });

  it('prints the as-of time beside the term', () => {
    render(<DefinitionTip term="Float" definition={DEF} asOf={new Date().toISOString()} />);
    expect(screen.getByText(/as of/)).toBeInTheDocument();
  });

  it('renders a plain term, not an empty trigger, without a definition', () => {
    render(<DefinitionTip term="Float" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Float')).toBeInTheDocument();
  });
});
