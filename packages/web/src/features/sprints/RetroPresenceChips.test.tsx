import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { usePresenceStore, type PresenceUser } from '@/stores/presenceStore';
import { RetroPresenceChips } from './RetroPresenceChips';

function seed(count: number): PresenceUser[] {
  return Array.from({ length: count }, (_, i) => ({
    user_id: `u${i}`,
    display_name: `Person ${String.fromCharCode(65 + i)}`,
  }));
}

beforeEach(() => {
  usePresenceStore.setState({ users: {} });
});

describe('RetroPresenceChips', () => {
  it('renders nothing when no one is present', () => {
    const { container } = renderWithProviders(<RetroPresenceChips />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not show a +N overflow trigger at or below the visible cap', () => {
    usePresenceStore.getState().setUsers(seed(5));
    renderWithProviders(<RetroPresenceChips />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a +N overflow trigger when more than five users are present', () => {
    usePresenceStore.getState().setUsers(seed(7));
    renderWithProviders(<RetroPresenceChips />);
    const trigger = screen.getByRole('button', { name: /show 2 more participants/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('+2');
  });

  it('reveals the overflowed participant names when the +N trigger is clicked', async () => {
    usePresenceStore.getState().setUsers(seed(7));
    renderWithProviders(<RetroPresenceChips />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /show 2 more participants/i });
    await userEvent.click(trigger);

    const popover = screen.getByRole('dialog', { name: /more retro participants/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Persons F and G are the two overflowed beyond the first five (A–E).
    expect(within(popover).getByText('Person F')).toBeInTheDocument();
    expect(within(popover).getByText('Person G')).toBeInTheDocument();
  });

  it('closes the popover on Escape and returns focus to the trigger', async () => {
    usePresenceStore.getState().setUsers(seed(7));
    renderWithProviders(<RetroPresenceChips />);

    const trigger = screen.getByRole('button', { name: /show 2 more participants/i });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });
});
