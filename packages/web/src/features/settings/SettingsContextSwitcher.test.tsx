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

describe('<SettingsContextSwitcher> search mode (>= 8 options)', () => {
  // 9 programs → the menu gains a type-to-filter search box (#776 follow-on).
  const MANY: SettingsContextOption[] = [
    'Apollo', 'Polaris', 'Gemini', 'Mercury', 'Vostok', 'Soyuz', 'Artemis', 'Orion', 'Skylab',
  ].map((name, i) => ({
    id: `p${i}`,
    name,
    health: 'onTrack' as const,
    to: `/programs/p${i}/settings/general`,
  }));

  function open(onSelect = vi.fn()) {
    render(
      <SettingsContextSwitcher
        contextName="Apollo"
        contextHealth="onTrack"
        options={MANY}
        activeId="p0"
        entityLabel="program"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    return onSelect;
  }

  it('renders a search combobox + listbox (not a menu) at the threshold', () => {
    open();
    expect(screen.getByRole('combobox', { name: 'Find a program' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Switch program' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(9);
  });

  it('typing filters the options by name (case-insensitive substring)', () => {
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'o' } });
    // Apollo, Polaris, Soyuz, Orion, Skylab contain "o" (case-insensitive).
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.every((n) => /o/i.test(n ?? ''))).toBe(true);
    expect(screen.queryByRole('option', { name: /Gemini/ })).not.toBeInTheDocument();
  });

  it('Enter selects the first filtered option', () => {
    const onSelect = open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'polaris' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/programs/p1/settings/general');
  });

  it('shows an empty state when nothing matches', () => {
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No programs match')).toBeInTheDocument();
  });

  it('Escape clears a query first, then closes on a second press', () => {
    open();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'mer' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('combobox')).toHaveValue(''); // cleared, still open
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); // closed
  });
});
