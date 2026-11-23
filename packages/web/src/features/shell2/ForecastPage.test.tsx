import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import type { MonteCarloResult } from '@/types';
import { SHELL_V2_FLAG } from './shellFlag';
import { ForecastPage } from './ForecastPage';

const q = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  run: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProjectRef', () => ({ useProjectRef: () => 'proj' }));
vi.mock('@/hooks/useMonteCarloResult', () => ({ useMonteCarloResult: () => q.current }));
vi.mock('@/hooks/useRunMonteCarlo', () => ({ useRunMonteCarlo: () => q.run }));
vi.mock('@/features/charts', () => ({
  SCurveChart: () => <div data-testid="scurve" />,
  HistogramChart: ({ buckets }: { buckets: unknown[] }) => (
    <div data-testid="histogram">{buckets.length}</div>
  ),
  forecastToSCurveProps: () => ({}),
}));

const result = {
  p50: '2026-06-01',
  p80: '2026-06-05',
  p95: '2026-06-09',
  lastRunAt: '2026-06-01T00:00:00Z',
  forecastStaleness: 'current',
} as Partial<MonteCarloResult>;

function set(partial: Record<string, unknown>) {
  q.current = { data: undefined, isLoading: false, error: null, refetch: vi.fn(), ...partial };
}

describe('ForecastPage', () => {
  beforeEach(() => {
    localStorage.clear();
    setFeatureFlag(SHELL_V2_FLAG, true);
    q.run = { mutate: vi.fn(), isPending: false, isError: false, error: null };
    set({ data: result });
  });

  it('redirects away when the flag is off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.queryByRole('heading', { name: 'Forecast' })).toBeNull();
  });

  it('renders the server percentiles and the chart when a forecast exists', () => {
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.getByRole('heading', { name: 'Forecast' })).toBeInTheDocument();
    expect(screen.getByTestId('scurve')).toBeInTheDocument();
    expect(screen.getByText(/As of/)).toBeInTheDocument();
  });

  it('draws the weekly histogram from the server buckets, and omits it when there are none', () => {
    set({ data: { ...result, buckets: [{ weekStart: '2026-06-01', count: 3 }] } });
    const { unmount } = renderWithRouter(<ForecastPage />, {
      initialEntries: ['/projects/proj/forecast'],
    });
    expect(screen.getByTestId('histogram')).toHaveTextContent('1');
    unmount();
    set({ data: { ...result, buckets: [] } });
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.queryByTestId('histogram')).toBeNull();
  });

  it('replaces the "as of" claim with a rerun prompt when stale', () => {
    set({ data: { ...result, forecastStaleness: 'projectChanged' } });
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.getByRole('status')).toHaveTextContent('The project has changed');
    expect(screen.queryByText(/As of/)).toBeNull();
  });

  it('says "Not run yet" when there is no forecast', () => {
    set({ data: undefined });
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.getByRole('heading', { name: 'Not run yet' })).toBeInTheDocument();
  });

  it('shows an error, not "Not run yet", when the read fails', () => {
    set({ error: new Error('boom') });
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.getByText("Couldn't load the forecast.")).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Not run yet' })).toBeNull();
  });

  it('shows a loading state while the read is in flight', () => {
    set({ isLoading: true });
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.queryByTestId('scurve')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Not run yet' })).toBeNull();
  });

  it('runs the forecast from the toolbar button', () => {
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    fireEvent.click(screen.getByRole('button', { name: 'Run forecast' }));
    expect(q.run.mutate).toHaveBeenCalledWith({});
  });

  it('disables the button and says Running… while a run is pending', () => {
    q.run = { ...q.run, isPending: true };
    renderWithRouter(<ForecastPage />, { initialEntries: ['/projects/proj/forecast'] });
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
  });
});
