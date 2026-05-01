import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { HeatmapCell } from './HeatmapCell';

describe('HeatmapCell', () => {
  it('renders the utilization percentage', () => {
    render(<HeatmapCell util={80} resourceName="Anna Khoury" weekLabel="2026-W18" onClick={vi.fn()} />);
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('renders nothing (empty) when util is 0', () => {
    render(<HeatmapCell util={0} resourceName="Anna Khoury" weekLabel="2026-W18" onClick={vi.fn()} />);
    // Should render button with empty text
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('');
  });

  it('has accessible aria-label including resource, week, and percent', () => {
    render(<HeatmapCell util={95} resourceName="Jordan Mehta" weekLabel="2026-W20" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Jordan Mehta, W20, 95% utilized/i })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<HeatmapCell util={80} resourceName="Sam Reyes" weekLabel="2026-W18" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies green-tinted background for util < 100', () => {
    render(<HeatmapCell util={70} resourceName="Emily Lin" weekLabel="2026-W18" onClick={vi.fn()} />);
    const btn = screen.getByRole('button');
    // cellColor for 70% returns a green-ish rgba; just check it's not red
    expect(btn.style.backgroundColor).not.toContain('185, 28, 28');
  });

  it('applies red-tinted background for util > 100', () => {
    render(<HeatmapCell util={120} resourceName="Devon Wright" weekLabel="2026-W21" onClick={vi.fn()} />);
    const btn = screen.getByRole('button');
    // cellColor for 120% returns rgba(185, 28, 28, ...)
    expect(btn.style.backgroundColor).toContain('185, 28, 28');
  });
});
