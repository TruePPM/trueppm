import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RiskSegmentedFilter } from './RiskSegmentedFilter';
import type { RiskFilter } from './riskFilters';

function setup(value: RiskFilter = 'all') {
  const onChange = vi.fn();
  render(<RiskSegmentedFilter value={value} onChange={onChange} />);
  const group = screen.getByRole('radiogroup', { name: 'Filter risks' });
  return { group, onChange };
}

describe('RiskSegmentedFilter', () => {
  it('renders four radios with only the checked one tabbable (roving tabindex)', () => {
    const { group } = setup('all');
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(within(group).getByRole('radio', { name: 'High' })).toHaveAttribute('tabindex', '-1');
  });

  it('commits selection on click (activation), not on arrow keys', () => {
    const { onChange } = setup('all');
    fireEvent.click(screen.getByRole('radio', { name: 'Unmitigated' }));
    expect(onChange).toHaveBeenCalledWith('unmitigated');
  });

  it('ArrowRight moves DOM focus without committing (rule 167)', () => {
    const { group, onChange } = setup('all');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    // Focus moves to High and roving tabindex follows; no filter is applied.
    expect(screen.getByRole('radio', { name: 'High' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '-1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowLeft focus is clamped at the first option', () => {
    const { group } = setup('all');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveFocus();
  });

  it('End focuses the last option, Home the first — still no commit until activation', () => {
    const { group, onChange } = setup('all');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Mine' })).toHaveFocus();

    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});
