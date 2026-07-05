import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ExportSegmentedField, type SegmentOption } from './ExportSegmentedField';

type V = 'a' | 'b' | 'c';
const OPTIONS: SegmentOption<V>[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true, title: 'soon' },
  { value: 'c', label: 'Gamma' },
];

describe('ExportSegmentedField', () => {
  it('is a labelled radiogroup with the selected option as the roving tab stop', () => {
    render(
      <ExportSegmentedField
        legend="Choice"
        name="choice"
        options={OPTIONS}
        value="a"
        onChange={vi.fn()}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Choice' });
    expect(within(group).getByRole('radio', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
    expect(within(group).getByRole('radio', { name: 'Gamma' })).toHaveAttribute('tabindex', '-1');
  });

  it('renders a disabled option with its hint and no selectability', () => {
    render(
      <ExportSegmentedField
        legend="Choice"
        name="choice"
        options={OPTIONS}
        value="a"
        onChange={vi.fn()}
      />,
    );
    const beta = screen.getByRole('radio', { name: 'Beta' });
    expect(beta).toBeDisabled();
    expect(beta).toHaveAttribute('title', 'soon');
  });

  it('ArrowRight skips the disabled option and commits the next enabled value', () => {
    const onChange = vi.fn();
    render(
      <ExportSegmentedField
        legend="Choice"
        name="choice"
        options={OPTIONS}
        value="a"
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowRight' });
    // Beta is disabled, so it wraps past it to Gamma.
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('ArrowLeft wraps around from the first enabled option to the last', () => {
    const onChange = vi.fn();
    render(
      <ExportSegmentedField
        legend="Choice"
        name="choice"
        options={OPTIONS}
        value="a"
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('clicking an enabled option commits it; clicking disabled does nothing', () => {
    const onChange = vi.fn();
    render(
      <ExportSegmentedField
        legend="Choice"
        name="choice"
        options={OPTIONS}
        value="a"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
    onChange.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
