import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsContextSwitcher, type SettingsContextOption } from './SettingsContextSwitcher';

const OPTIONS: SettingsContextOption[] = [
  { id: 'p1', name: 'test',  health: 'onTrack', to: '/programs/p1/settings/general' },
  { id: 'p2', name: 'test2', health: 'critical', to: '/programs/p2/settings/general' },
];

function renderSwitcher(onSelect = vi.fn()) {
  render(
    <SettingsContextSwitcher
      contextName="test"
      contextHealth="onTrack"
      options={OPTIONS}
      activeId="p1"
      entityLabel="program"
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe('<SettingsContextSwitcher>', () => {
  it('renders a trigger labelled with the current entity and is closed initially', () => {
    renderSwitcher();
    expect(
      screen.getByRole('button', { name: 'Current program: test, on track. Switch program.' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a menu listing all sibling entities with the active one checked', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));

    const menu = screen.getByRole('menu', { name: 'Switch program' });
    expect(menu).toBeInTheDocument();
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('menuitemradio', { name: 'test2, critical' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'test, on track' })).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting a different entity calls onSelect with its route', () => {
    const onSelect = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /test2/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/programs/p2/settings/general');
  });

  it('selecting the current entity is a no-op (just closes the menu)', () => {
    const onSelect = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'test, on track' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape closes the menu', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
