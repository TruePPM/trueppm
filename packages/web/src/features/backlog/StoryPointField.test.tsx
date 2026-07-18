import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoryPointField } from './StoryPointField';

function optionLabels(): string[] {
  return Array.from(screen.getByRole('combobox').querySelectorAll('option')).map(
    (o) => o.textContent ?? '',
  );
}

describe('StoryPointField', () => {
  it('offers the Fibonacci ladder plus the empty option', () => {
    render(<StoryPointField scale="fibonacci" value={null} onChange={vi.fn()} />);
    expect(optionLabels()).toEqual(['—', '1', '2', '3', '5', '8', '13', '21']);
  });

  it('shows T-shirt LABELS but submits the mapped INTEGER', () => {
    const onChange = vi.fn();
    render(<StoryPointField scale="tshirt" value={null} onChange={onChange} />);
    expect(optionLabels()).toEqual(['—', 'XS', 'S', 'M', 'L', 'XL']);

    // Selecting "M" (option value = mapped int 3) emits 3, not the label.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('emits null when the empty option is chosen', () => {
    const onChange = vi.fn();
    render(<StoryPointField scale="fibonacci" value={5} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('preserves an off-scale legacy value as a selectable (N) option', () => {
    render(<StoryPointField scale="fibonacci" value={4} onChange={vi.fn()} />);
    // 4 is not on the Fibonacci ladder but must still appear and be selected.
    expect(optionLabels()).toContain('(4)');
    expect(screen.getByRole('combobox')).toHaveValue('4');
  });

  it('preserves an off-scale value under a T-shirt scale', () => {
    render(<StoryPointField scale="tshirt" value={7} onChange={vi.fn()} />);
    expect(optionLabels()).toEqual(['—', 'XS', 'S', 'M', 'L', 'XL', '(7)']);
    expect(screen.getByRole('combobox')).toHaveValue('7');
  });

  it('disables the control when read-only', () => {
    render(<StoryPointField scale="fibonacci" value={3} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
