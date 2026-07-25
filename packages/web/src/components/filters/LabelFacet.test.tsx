import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LabelFacet } from './LabelFacet';
import type { Label } from '@/hooks/useLabels';

function label(id: string, name: string, color = 'teal'): Label {
  return { id, name, color, position: 0, serverVersion: 1, taskCount: 0 };
}

const CATALOG = [
  label('l1', 'Needs review'),
  label('l2', 'Blocked', 'rose'),
  label('l3', 'Client sign-off', 'amber'),
  label('l4', 'Rework', 'purple'),
];

const COUNTS = { l1: 18, l2: 4, l3: 26, l4: 0 };

function setup(overrides: Partial<ComponentProps<typeof LabelFacet>> = {}) {
  const onChange = vi.fn();
  const props = {
    labels: CATALOG,
    counts: COUNTS,
    selected: [] as string[],
    onChange,
    ...overrides,
  };
  const view = render(<LabelFacet {...props} />);
  return { onChange, view, props };
}

describe('LabelFacet trigger', () => {
  it('reads "Label: any" with nothing selected', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Label: any' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  });

  it('names the single selected label, and collapses several to "+N"', () => {
    const { view } = setup({ selected: ['l1'] });
    expect(screen.getByRole('button', { name: /Label: Needs review/ })).toBeInTheDocument();
    view.rerender(
      <LabelFacet labels={CATALOG} counts={COUNTS} selected={['l1', 'l2']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Label: Needs review \+1/ })).toBeInTheDocument();
  });
});

describe('LabelFacet panel', () => {
  it('lists the full catalog with counts, including a visible 0', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    const options = screen.getAllByRole('menuitemcheckbox');
    expect(options).toHaveLength(4);
    // The unused label is present and reads 0 — the pre-click signal that makes a
    // zero-result selection deliberate (ADR-0620 decision 2).
    expect(options[3]).toHaveTextContent('Rework');
    expect(options[3]).toHaveTextContent('0');
  });

  it('always renders the label name next to its swatch (color is never the only cue)', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    for (const name of ['Needs review', 'Blocked', 'Client sign-off', 'Rework']) {
      expect(screen.getByRole('menuitemcheckbox', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it('toggles selection without closing, so results update behind the panel', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Needs review/ }));
    expect(onChange).toHaveBeenCalledWith(['l1']);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('deselects an already-selected label', async () => {
    const { onChange } = setup({ selected: ['l1', 'l2'] });
    await userEvent.click(screen.getByRole('button', { name: /Label: Needs review/ }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Needs review/ }));
    expect(onChange).toHaveBeenCalledWith(['l2']);
  });

  it('hides the search field at 8 labels or fewer', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    expect(screen.queryByLabelText('Filter label options')).not.toBeInTheDocument();
  });

  it('grows a search field once the catalog exceeds 8 labels', async () => {
    const big = Array.from({ length: 9 }, (_, i) => label(`b${i}`, `Label ${i}`));
    setup({ labels: big, counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    expect(screen.getByLabelText('Filter label options')).toBeInTheDocument();
  });

  it('search narrows the options but never the selection', async () => {
    const big = [...CATALOG, ...Array.from({ length: 6 }, (_, i) => label(`x${i}`, `Other ${i}`))];
    setup({ labels: big, selected: ['l2'] });
    await userEvent.click(screen.getByRole('button', { name: /Label: Blocked/ }));
    await userEvent.type(screen.getByLabelText('Filter label options'), 'rew');
    // Only "Rework" contains "rew". "Blocked" is filtered out of the list, but
    // the trigger still reports it as selected — search narrows what you can see,
    // never what is applied.
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);
    expect(screen.getByRole('menuitemcheckbox', { name: /Rework/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Label: Blocked/ })).toBeInTheDocument();
  });

  it('typing the whole query narrows the list — focus stays in the search field', async () => {
    // Regression: the roving-focus effect used to fire on every list-length
    // change, pulling focus out of the input after one keystroke so the rest of
    // the query was swallowed by the option list's type-ahead.
    const big = [...CATALOG, ...Array.from({ length: 6 }, (_, i) => label(`x${i}`, `Other ${i}`))];
    setup({ labels: big });
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    const search = screen.getByLabelText('Filter label options');
    await userEvent.type(search, 'client');
    expect(search).toHaveValue('client');
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);
  });
});

describe('LabelFacet keyboard model', () => {
  it('ArrowDown from the trigger opens the panel and focuses the first option', async () => {
    setup();
    screen.getByRole('button', { name: 'Label: any' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Needs review/ })).toHaveFocus();
  });

  it('is a single tab stop — exactly one option is tabbable at a time', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    await userEvent.keyboard('{ArrowDown}');
    const tabbable = screen
      .getAllByRole('menuitemcheckbox')
      .filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('ArrowDown/ArrowUp wrap, and Home/End jump to the ends', async () => {
    setup();
    screen.getByRole('button', { name: 'Label: any' }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowUp}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Rework/ })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Needs review/ })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitemcheckbox', { name: /Rework/ })).toHaveFocus();
  });

  it('Space toggles without closing', async () => {
    const { onChange } = setup();
    screen.getByRole('button', { name: 'Label: any' }).focus();
    await userEvent.keyboard('{ArrowDown}[Space]');
    expect(onChange).toHaveBeenCalledWith(['l1']);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('type-ahead jumps to the next option starting with the typed letter', async () => {
    setup();
    screen.getByRole('button', { name: 'Label: any' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('c');
    expect(screen.getByRole('menuitemcheckbox', { name: /Client sign-off/ })).toHaveFocus();
  });

  it('Escape closes and returns focus to the trigger', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Label: any' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('LabelFacet footer', () => {
  it('Clear labels is disabled until something is selected', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    expect(screen.getByRole('button', { name: 'Clear labels' })).toBeDisabled();
  });

  it('Clear labels drops every label', async () => {
    const { onChange } = setup({ selected: ['l1', 'l2'] });
    await userEvent.click(screen.getByRole('button', { name: /Label: Needs review/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear labels' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('renders host-supplied footer controls above Clear labels', async () => {
    setup({ footerExtra: <button type="button">Hide non-matching rows</button> });
    await userEvent.click(screen.getByRole('button', { name: 'Label: any' }));
    expect(screen.getByRole('button', { name: 'Hide non-matching rows' })).toBeInTheDocument();
  });
});

describe('LabelFacet with no labels in the project', () => {
  it('stays discoverable and explains where labels come from', async () => {
    const onOpenLabelSettings = vi.fn();
    setup({ labels: [], counts: {}, onOpenLabelSettings });
    const trigger = screen.getByRole('button', { name: 'Label: none yet' });
    await userEvent.click(trigger);
    expect(screen.getByText('No labels in this project yet')).toBeInTheDocument();
    expect(screen.getByText(/scoped to this project/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open label settings' }));
    expect(onOpenLabelSettings).toHaveBeenCalled();
  });

  it('omits the settings link when the host cannot navigate there', async () => {
    setup({ labels: [], counts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Label: none yet' }));
    expect(screen.queryByRole('button', { name: 'Open label settings' })).not.toBeInTheDocument();
  });
});
