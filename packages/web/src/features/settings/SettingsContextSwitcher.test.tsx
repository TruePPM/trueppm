import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsContextSwitcher, type SettingsContextOption } from './SettingsContextSwitcher';

const OPTIONS: SettingsContextOption[] = [
  { id: 'p1', name: 'test',  health: 'onTrack', to: '/programs/p1/settings/general' },
  { id: 'p2', name: 'test2', health: 'critical', to: '/programs/p2/settings/general' },
];

function renderSwitcher(onSelect = vi.fn(), options = OPTIONS) {
  render(
    <SettingsContextSwitcher
      contextName="test"
      contextHealth="onTrack"
      options={options}
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
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens a search combobox + listbox of options, with the active one selected', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));

    expect(screen.getByRole('combobox', { name: 'Find a program' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Switch program' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); // not a menu pattern
    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'test2, critical' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: 'test, on track' })).toHaveAttribute('aria-selected', 'true');
  });

  it('selecting a different entity calls onSelect with its route', () => {
    const onSelect = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.click(screen.getByRole('option', { name: 'test2, critical' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/programs/p2/settings/general');
  });

  it('selecting the current entity is a no-op (just closes)', () => {
    const onSelect = renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.click(screen.getByRole('option', { name: 'test, on track' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape with an empty query closes the popover', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Switch program/ }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('<SettingsContextSwitcher> search filtering', () => {
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

  it('typing filters the options by name (case-insensitive substring)', () => {
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'o' } });
    const names = screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
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
