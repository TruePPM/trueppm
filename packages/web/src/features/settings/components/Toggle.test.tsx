import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from './Toggle';
import { setFeatureFlag } from '@/lib/featureFlags';

describe('Toggle', () => {
  it('carries the focus ring and flips on click', async () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} ariaLabel="Thing" onLabel="" offLabel="" />);
    const sw = screen.getByRole('switch', { name: 'Thing' });
    expect(sw.className).toContain('focus-visible:ring-2');
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('busy announces aria-busy and ignores clicks', async () => {
    const onChange = vi.fn();
    render(<Toggle on ariaLabel="Thing" onChange={onChange} busy />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('softDisabled stays focusable, is aria-disabled, ignores clicks and carries describedBy', async () => {
    const onChange = vi.fn();
    render(<Toggle on ariaLabel="Thing" onChange={onChange} softDisabled describedBy="why" />);
    const sw = screen.getByRole('switch');
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).toHaveAttribute('aria-describedby', 'why');
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Toggle under shell_v2 (#4800)', () => {
  afterEach(() => setFeatureFlag('shell_v2', false));

  it('is a 44px target around a 36x20 track and still writes the state', () => {
    setFeatureFlag('shell_v2', true);
    render(<Toggle on onChange={vi.fn()} ariaLabel="Guests" hint="3 guests" />);
    const sw = screen.getByRole('switch', { name: 'Guests' });
    expect(sw.className).toContain('min-h-11');
    expect(sw.firstElementChild?.className).toContain('w-9 h-5');
    expect(sw).toHaveTextContent('Enabled');
    expect(sw).toHaveTextContent('3 guests');
  });

  it('keeps the v1 18px track with the flag off', () => {
    render(<Toggle on onChange={vi.fn()} ariaLabel="Guests" />);
    expect(screen.getByRole('switch').firstElementChild?.className).toContain('h-[18px]');
  });
});
