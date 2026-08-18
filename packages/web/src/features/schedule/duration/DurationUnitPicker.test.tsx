import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DurationUnitPicker } from './DurationUnitPicker';

describe('DurationUnitPicker', () => {
  afterEach(cleanup);

  it('exposes a radiogroup with a full word per option, not a bare glyph', () => {
    // "d" announced on its own tells a screen reader user nothing.
    render(<DurationUnitPicker value="days" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Duration unit' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Days' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Hours' })).not.toBeChecked();
  });

  it('selects on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Hours' }));
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('moves between options with arrow keys — the radiogroup contract', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Days' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('wraps around rather than dead-ending at the edge', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DurationUnitPicker value="days" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Days' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('hours');
  });

  it('keeps only the selected option in the tab order', () => {
    render(<DurationUnitPicker value="hours" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Hours' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Days' })).toHaveAttribute('tabindex', '-1');
  });

  it('disables both options together', () => {
    render(<DurationUnitPicker value="days" onChange={() => {}} disabled />);
    expect(screen.getByRole('radio', { name: 'Days' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Hours' })).toBeDisabled();
  });
});
