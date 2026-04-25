import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CapacityInput } from './CapacityInput';

// Stub localStorage — reset between tests so unit preference doesn't bleed.
let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => store[k] ?? null);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => { store[k] = String(v); });
});

describe('CapacityInput', () => {
  it('renders % FTE mode by default', () => {
    render(<CapacityInput value={1.0} onChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: '% FTE' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('spinbutton')).toHaveValue(100);
  });

  it('shows conversion hint in percent mode', () => {
    render(<CapacityInput value={0.5} onChange={vi.fn()} calendarHoursPerDay={8} />);
    expect(screen.getByText(/4\.0h\/day/)).toBeInTheDocument();
  });

  it('switches to hours mode and recalculates display value', () => {
    render(<CapacityInput value={0.5} onChange={vi.fn()} calendarHoursPerDay={8} />);
    fireEvent.click(screen.getByRole('tab', { name: 'h/day' }));
    expect(screen.getByRole('spinbutton')).toHaveValue(4);
    expect(screen.getByRole('tab', { name: 'h/day' })).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onChange with decimal value when editing in percent mode', () => {
    const onChange = vi.fn();
    render(<CapacityInput value={1.0} onChange={onChange} calendarHoursPerDay={8} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } });
    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  it('calls onChange with decimal value when editing in hours mode', () => {
    const onChange = vi.fn();
    render(<CapacityInput value={1.0} onChange={onChange} calendarHoursPerDay={8} />);
    fireEvent.click(screen.getByRole('tab', { name: 'h/day' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('shows project override chip when isOverride is true', () => {
    render(<CapacityInput value={0.5} onChange={vi.fn()} isOverride />);
    expect(screen.getByText('Project override')).toBeInTheDocument();
  });

  it('clamps percent value to 200 maximum', () => {
    const onChange = vi.fn();
    render(<CapacityInput value={1.0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    expect(onChange).toHaveBeenCalledWith(2.0);
  });
});
