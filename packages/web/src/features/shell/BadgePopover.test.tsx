import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { BadgePopover } from './BadgePopover';

const items = [
  { id: 't1', wbs: '1.1', name: 'Backend Implementation' },
  { id: 't2', wbs: '1.2', name: 'Frontend Build' },
];

describe('BadgePopover', () => {
  it('renders the trigger button with count', () => {
    renderWithProviders(
      <BadgePopover
        label="2 at risk tasks"
        count={2}
        items={items}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /2 at risk tasks/i })).toBeInTheDocument();
  });

  it('popover is closed by default', () => {
    renderWithProviders(
      <BadgePopover
        label="2 at risk tasks"
        count={2}
        items={items}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={vi.fn()}
      />
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens popover on click showing task items', async () => {
    renderWithProviders(
      <BadgePopover
        label="2 at risk tasks"
        count={2}
        items={items}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /2 at risk tasks/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
    expect(screen.getByText('Frontend Build')).toBeInTheDocument();
  });

  it('calls onItemClick and dismisses on item click', async () => {
    const onItemClick = vi.fn();
    renderWithProviders(
      <BadgePopover
        label="2 at risk tasks"
        count={2}
        items={items}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={onItemClick}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /2 at risk tasks/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Backend Implementation/i }));
    expect(onItemClick).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    renderWithProviders(
      <BadgePopover
        label="2 at risk tasks"
        count={2}
        items={items}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /2 at risk tasks/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows overflow label when items exceed MAX_VISIBLE', async () => {
    const manyItems = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      wbs: `1.${i}`,
      name: `Task ${i}`,
    }));
    renderWithProviders(
      <BadgePopover
        label="7 at risk tasks"
        count={7}
        items={manyItems}
        colorVariant="at-risk"
        icon={<span>!</span>}
        onItemClick={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /7 at risk tasks/i }));
    expect(screen.getByText(/2 more/i)).toBeInTheDocument();
  });
});
