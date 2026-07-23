import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddDetailRow } from './AddDetailRow';

describe('AddDetailRow (progressive disclosure, ADR-0605)', () => {
  it('renders nothing when there is nothing to add', () => {
    const { container } = render(<AddDetailRow items={[]} onReveal={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one labeled button per offered section under an "Add detail" region', () => {
    render(
      <AddDetailRow
        items={[
          { id: 'sprint', label: 'Sprint' },
          { id: 'blocker', label: 'Blocker' },
        ]}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'Add detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sprint' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Blocker' })).toBeInTheDocument();
  });

  it('uses the resolved (iteration) label as the button accessible name', () => {
    // The Sprint button is labeled by the configurable iteration label, so a
    // "Cycles" workspace offers "+ Cycle", not a hardcoded "Sprint".
    render(<AddDetailRow items={[{ id: 'sprint', label: 'Cycle' }]} onReveal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cycle' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sprint' })).not.toBeInTheDocument();
  });

  it('reveals the section id on click', async () => {
    const onReveal = vi.fn();
    render(<AddDetailRow items={[{ id: 'dependencies', label: 'Dependencies' }]} onReveal={onReveal} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith('dependencies');
  });
});
