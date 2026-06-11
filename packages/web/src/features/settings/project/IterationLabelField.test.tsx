import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { IterationLabelField } from './IterationLabelField';

describe('IterationLabelField', () => {
  it('selects the matching preset radio for a preset value', () => {
    render(<IterationLabelField value="Sprint" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Sprint' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Iteration' })).not.toBeChecked();
    // No custom input while a preset is selected.
    expect(screen.queryByLabelText('Custom iteration label')).not.toBeInTheDocument();
  });

  it('emits the preset when a chip is clicked', () => {
    const onChange = vi.fn();
    render(<IterationLabelField value="Sprint" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Iteration' }));
    expect(onChange).toHaveBeenCalledWith('Iteration');
  });

  it('reveals the custom input and clears the value when Custom is chosen from a preset', () => {
    const onChange = vi.fn();
    render(<IterationLabelField value="Sprint" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Custom…' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByLabelText('Custom iteration label')).toBeInTheDocument();
  });

  it('treats a non-preset value as custom with the input pre-filled', () => {
    render(<IterationLabelField value="Cycle" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Custom…' })).toBeChecked();
    expect(screen.getByLabelText('Custom iteration label')).toHaveValue('Cycle');
  });

  it('emits typed custom text', () => {
    const onChange = vi.fn();
    render(<IterationLabelField value="Cycle" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Custom iteration label'), { target: { value: 'Wave' } });
    expect(onChange).toHaveBeenCalledWith('Wave');
  });

  it('shows the pluralized live preview', () => {
    render(<IterationLabelField value="Cycle" onChange={vi.fn()} />);
    // "No {lowerPlural} yet" and "Last 8 {lowerPlural}" use the derived plural.
    expect(screen.getByText(/No cycles yet/)).toBeInTheDocument();
    expect(screen.getByText(/Last 8 cycles/)).toBeInTheDocument();
    expect(screen.getByText(/Cycle Goal/)).toBeInTheDocument();
  });

  it('shows an inline error and marks the input invalid when custom is empty', () => {
    render(<IterationLabelField value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText('Custom iteration label');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a label or pick a preset.')).toBeInTheDocument();
  });

  it('renders a character counter against the 32-char cap', () => {
    render(<IterationLabelField value="Cycle" onChange={vi.fn()} />);
    expect(screen.getByText('5/32')).toBeInTheDocument();
  });
});
