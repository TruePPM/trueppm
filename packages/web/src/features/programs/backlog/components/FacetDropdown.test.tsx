import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FacetDropdown, type FacetOption } from './FacetDropdown';

const OPTIONS: FacetOption[] = [
  { value: 'story', label: 'Story' },
  { value: 'bug', label: 'Bug' },
  { value: 'spike', label: 'Spike' },
];

const onChange = vi.fn();
beforeEach(() => onChange.mockReset());

function renderFacet(selected: string[] = [], searchable = false) {
  return render(
    <div>
      <button type="button">outside</button>
      <FacetDropdown
        label="Type"
        options={OPTIONS}
        selected={selected}
        onChange={onChange}
        searchable={searchable}
      />
    </div>,
  );
}

describe('FacetDropdown', () => {
  it('summarizes the selection on the trigger: any / one / first +N', () => {
    const { rerender } = renderFacet();
    expect(screen.getByRole('button', { name: 'Type: any' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rerender(
      <FacetDropdown label="Type" options={OPTIONS} selected={['bug']} onChange={onChange} />,
    );
    expect(screen.getByRole('button', { name: 'Type: Bug' })).toBeInTheDocument();
    rerender(
      <FacetDropdown
        label="Type"
        options={OPTIONS}
        selected={['bug', 'spike']}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Type: Bug +1' })).toBeInTheDocument();
  });

  it('opens a checkbox menu and toggles values with AND semantics', async () => {
    const user = userEvent.setup();
    renderFacet(['bug']);
    await user.click(screen.getByRole('button', { name: 'Type: Bug' }));
    const menu = screen.getByRole('menu', { name: 'Filter by type' });
    expect(menu).toBeInTheDocument();
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);

    await user.click(items[0]);
    expect(onChange).toHaveBeenLastCalledWith(['bug', 'story']);
    await user.click(items[1]);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('closes on an outside mousedown and stays open on an inside one', async () => {
    const user = userEvent.setup();
    renderFacet();
    await user.click(screen.getByRole('button', { name: 'Type: any' }));
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderFacet();
    const trigger = screen.getByRole('button', { name: 'Type: any' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // A second click toggles it back open.
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('searchable: filters the options and reports when nothing matches', async () => {
    const user = userEvent.setup();
    renderFacet([], true);
    await user.click(screen.getByRole('button', { name: 'Type: any' }));
    const search = screen.getByRole('textbox', { name: 'Filter type options' });
    await user.type(search, 'sp');
    expect(screen.getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual(['Spike']);
    await user.type(search, 'zz');
    expect(screen.queryAllByRole('menuitemcheckbox')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});
