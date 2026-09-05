import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MethodologyFilter,
  type MethodologyDeviationFilterValue,
  type MethodologyFilterValue,
} from './MethodologyFilter';

function setup(value: MethodologyFilterValue = 'ALL') {
  const onChange = vi.fn();
  render(<MethodologyFilter value={value} onChange={onChange} />);
  const group = screen.getByRole('radiogroup', { name: 'Filter by methodology' });
  return { group, onChange };
}

describe('MethodologyFilter (#564)', () => {
  it('renders four radios with only the checked one tabbable (roving tabindex)', () => {
    const { group } = setup('ALL');
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(within(group).getByRole('radio', { name: 'Waterfall' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('fills the active segment so selection is conveyed by more than text shade (rule 179)', () => {
    setup('AGILE');
    const active = screen.getByRole('radio', { name: 'Agile' });
    expect(active.className).toContain('bg-brand-primary');
    expect(active.className).toContain('text-neutral-text-inverse');
  });

  it('commits selection on click (activation)', () => {
    const { onChange } = setup('ALL');
    fireEvent.click(screen.getByRole('radio', { name: 'Hybrid' }));
    expect(onChange).toHaveBeenCalledWith('HYBRID');
  });

  it('ArrowRight moves DOM focus without committing (rule 167)', () => {
    const { group, onChange } = setup('ALL');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Waterfall' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Waterfall' })).toHaveAttribute('tabindex', '0');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Home/End scan focus across segments without committing (rule 167)', () => {
    const { group, onChange } = setup('ALL');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Hybrid' })).toHaveFocus();
    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MethodologyFilter — deviation facet + counts (#3295)', () => {
  function setupDeviation(
    value: MethodologyDeviationFilterValue = 'ALL',
    opts: {
      deviationOption?: { label: string; count: number };
      collapseFacets?: boolean;
      counts?: Partial<Record<'ALL' | 'WATERFALL' | 'AGILE' | 'HYBRID', number>>;
    } = {},
  ) {
    const onChange = vi.fn();
    render(
      <MethodologyFilter<MethodologyDeviationFilterValue>
        value={value}
        onChange={onChange}
        counts={opts.counts ?? { ALL: 47, WATERFALL: 12, AGILE: 20, HYBRID: 15 }}
        collapseFacets={opts.collapseFacets}
        deviationOption={
          'deviationOption' in opts
            ? opts.deviationOption
            : { label: 'Deviates from default', count: 12 }
        }
      />,
    );
    return { group: screen.getByRole('radiogroup', { name: 'Filter by methodology' }), onChange };
  }

  it('appends a fifth option whose count is INSIDE its accessible name (one label)', () => {
    const { group } = setupDeviation();
    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    // accname trims text nodes, so a bare "Deviates from default" + "12" would read as
    // a label and an orphan number; the explicit aria-label keeps it one thing.
    expect(
      within(group).getByRole('radio', { name: 'Deviates from default, 12' }),
    ).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'All, 47' })).toBeInTheDocument();
  });

  it('commits DEVIATES on activation', () => {
    const { onChange } = setupDeviation();
    fireEvent.click(screen.getByRole('radio', { name: 'Deviates from default, 12' }));
    expect(onChange).toHaveBeenCalledWith('DEVIATES');
  });

  it('renders a zero count as aria-disabled — reachable, keeping its place in the roving order', () => {
    const { group, onChange } = setupDeviation('ALL', {
      deviationOption: { label: 'Deviates from default', count: 0 },
    });
    const zero = within(group).getByRole('radio', { name: 'Deviates from default, 0' });
    // aria-disabled, NOT disabled: "I checked, and none" has to stay reachable to say so.
    expect(zero).toHaveAttribute('aria-disabled', 'true');
    expect(zero).not.toBeDisabled();
    fireEvent.click(zero);
    expect(onChange).not.toHaveBeenCalled();
    // Still in the roving order — End lands on it.
    fireEvent.keyDown(group, { key: 'End' });
    expect(zero).toHaveFocus();
  });

  it('omits the fifth option entirely when the mount passes none (flag unavailable)', () => {
    const { group } = setupDeviation('ALL', { deviationOption: undefined });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).queryByRole('radio', { name: /Deviates/ })).not.toBeInTheDocument();
  });

  it('collapses to All + Deviates on a narrow viewport (D40)', () => {
    const { group } = setupDeviation('ALL', { collapseFacets: true });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(group).getByRole('radio', { name: 'All, 47' })).toBeInTheDocument();
    expect(
      within(group).getByRole('radio', { name: 'Deviates from default, 12' }),
    ).toBeInTheDocument();
    // End must stop at the last *rendered* option, not at a stale index.
    fireEvent.keyDown(group, { key: 'End' });
    expect(radios[1]).toHaveFocus();
  });

  it('leaves the two pre-#3295 mounts unchanged — no counts, four bare labels', () => {
    const { group } = setup('ALL');
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'All' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'All' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });
});
