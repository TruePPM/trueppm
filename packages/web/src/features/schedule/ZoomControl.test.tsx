import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { ZOOM_CONFIGS, MAX_PX_PER_DAY, MIN_PX_PER_DAY } from './engine';
import { ZoomControl } from './ZoomControl';

describe('ZoomControl (continuous-zoom stepper, #351)', () => {
  beforeEach(() => {
    useScheduleStore.setState({ pxPerDay: ZOOM_CONFIGS.week.pxPerDay, zoomLevel: 'week' });
  });

  it('renders a Timeline zoom group with −/+ buttons and a tier readout', () => {
    renderWithProviders(<ZoomControl />);
    expect(screen.getByRole('group', { name: 'Timeline zoom' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    // The derived tier is shown in a non-interactive live region, not a button.
    expect(screen.getByRole('status')).toHaveTextContent('Week');
  });

  it('Zoom in increases pxPerDay geometrically and updates the derived tier', async () => {
    renderWithProviders(<ZoomControl />);
    const before = useScheduleStore.getState().pxPerDay;
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useScheduleStore.getState().pxPerDay).toBeGreaterThan(before);
    // week (12) ×1.5 ×1.5 = 27 → crosses into the 'day' band.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useScheduleStore.getState().zoomLevel).toBe('day');
    expect(screen.getByRole('status')).toHaveTextContent('Day');
  });

  it('Zoom out decreases pxPerDay', async () => {
    renderWithProviders(<ZoomControl />);
    const before = useScheduleStore.getState().pxPerDay;
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(useScheduleStore.getState().pxPerDay).toBeLessThan(before);
  });

  it('disables Zoom in at the max band edge', () => {
    useScheduleStore.setState({ pxPerDay: MAX_PX_PER_DAY, zoomLevel: 'day' });
    renderWithProviders(<ZoomControl />);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });

  it('disables Zoom out at the min band edge', () => {
    useScheduleStore.setState({ pxPerDay: MIN_PX_PER_DAY, zoomLevel: 'year' });
    renderWithProviders(<ZoomControl />);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
  });

  it('renders a Fit-to-project button that calls onFit', async () => {
    const onFit = vi.fn();
    renderWithProviders(<ZoomControl onFit={onFit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fit schedule to window' }));
    expect(onFit).toHaveBeenCalledTimes(1);
  });
});
