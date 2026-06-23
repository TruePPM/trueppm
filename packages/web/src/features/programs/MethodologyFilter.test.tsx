import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MethodologyFilter, type MethodologyFilterValue } from './MethodologyFilter';

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
