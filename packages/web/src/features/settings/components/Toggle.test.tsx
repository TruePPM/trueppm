import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from './Toggle';

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
