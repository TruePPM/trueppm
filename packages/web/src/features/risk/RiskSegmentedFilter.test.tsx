import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('arrow keys scan focus across segments WITHOUT committing a filter (rule 167)', async () => {
    const { onChange } = setup('all');
    const radios = screen.getAllByRole('radio');

    radios[0].focus();
    // Scan All → High → Unmitigated → Mine. Arrow navigation moves DOM focus
    // only; a keyboard user must be free to read every segment label without the
    // register reapplying a filter on each passing option.
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(radios[3]).toHaveFocus();
    expect(radios[3]).toHaveAttribute('tabindex', '0');
    expect(radios[0]).toHaveAttribute('tabindex', '-1');
    expect(onChange).not.toHaveBeenCalled();

    // ArrowLeft walks focus back without committing either.
    await userEvent.keyboard('{ArrowLeft}');
    expect(radios[2]).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Enter on the focused segment commits that filter (activation, rule 167)', async () => {
    const { onChange } = setup('all');
    const radios = screen.getAllByRole('radio');

    radios[0].focus();
    await userEvent.keyboard('{ArrowRight}'); // focus High, no commit yet
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.keyboard('{Enter}'); // activation commits the focused segment
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('Space on the focused segment commits that filter (activation, rule 167)', async () => {
    const { onChange } = setup('all');
    const radios = screen.getAllByRole('radio');

    radios[0].focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}'); // focus Unmitigated
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.keyboard(' '); // Space activates the native button
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('unmitigated');
  });
});
