import { act, screen } from '@testing-library/react';
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
    // The announced tier lives in a non-interactive, debounced sr-only live
    // region (not a button); on first render it already reflects the settled tier.
    expect(screen.getByRole('status')).toHaveTextContent('Week');
  });

  it('Zoom in increases pxPerDay geometrically and updates the visible tier immediately', async () => {
    renderWithProviders(<ZoomControl />);
    const before = useScheduleStore.getState().pxPerDay;
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useScheduleStore.getState().pxPerDay).toBeGreaterThan(before);
    // week (12) ×1.5 ×1.5 = 27 → crosses into the 'day' band.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useScheduleStore.getState().zoomLevel).toBe('day');
    // The VISIBLE readout updates instantly (the sr-only announcement is
    // debounced and still reads the pre-gesture 'Week' until it settles, so
    // 'Day' uniquely matches the visible span here).
    expect(screen.getByText('Day')).toBeInTheDocument();
  });

  it('announces only the settled tier after the debounce, not each intermediate one', () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(<ZoomControl />);
      // Both the visible readout and the announced (sr-only) value start at Week.
      expect(screen.getByRole('status')).toHaveTextContent('Week');

      // Simulate continuous zoom flipping through tiers (Week → Day → Month), as
      // a Ctrl+wheel / pinch gesture would, faster than the debounce window.
      act(() => {
        useScheduleStore.getState().setPxPerDay(ZOOM_CONFIGS.day.pxPerDay);
      });
      // Visible readout tracks the change instantly...
      expect(screen.getByText('Day')).toBeInTheDocument();
      // ...but the announcement has not settled — no stale 'Day' utterance queued.
      expect(screen.getByRole('status')).toHaveTextContent('Week');

      act(() => {
        useScheduleStore.getState().setPxPerDay(ZOOM_CONFIGS.month.pxPerDay);
      });
      // Still within the debounce window: the announcement is unchanged.
      expect(screen.getByRole('status')).toHaveTextContent('Week');

      // Once the gesture settles, only the final tier is announced.
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Month');
    } finally {
      vi.useRealTimers();
    }
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
