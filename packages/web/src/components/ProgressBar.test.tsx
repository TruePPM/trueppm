import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('renders a determinate bar whose width tracks pct and exposes it to AT', () => {
    render(<ProgressBar pct={65} label="Creating tasks…" />);
    const bar = screen.getByRole('progressbar', { name: 'Creating tasks…' });
    expect(bar).toHaveAttribute('aria-valuenow', '65');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    const fill = bar.querySelector<HTMLElement>('[style]');
    expect(fill?.style.width).toBe('65%');
    expect(screen.getByText('Creating tasks…')).toBeInTheDocument();
  });

  it('clamps the fill width into 0–100 without altering the reported value', () => {
    const { rerender } = render(<ProgressBar pct={140} />);
    let bar = screen.getByRole('progressbar');
    expect(bar.querySelector<HTMLElement>('[style]')?.style.width).toBe('100%');
    expect(bar).toHaveAttribute('aria-valuenow', '140');

    rerender(<ProgressBar pct={-20} />);
    bar = screen.getByRole('progressbar');
    expect(bar.querySelector<HTMLElement>('[style]')?.style.width).toBe('0%');
  });

  it('renders indeterminate (pulse) mode for a null pct with no aria-valuenow', () => {
    render(<ProgressBar pct={null} />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar.querySelector('[style]')).toBeNull();
    expect(bar.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull();
  });

  it('omits the caption when no label is given and forwards className', () => {
    render(<ProgressBar pct={10} className="mt-2" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('mt-2');
    expect(bar.querySelector('p')).toBeNull();
  });
});
