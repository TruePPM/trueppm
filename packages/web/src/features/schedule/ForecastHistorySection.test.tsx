import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ForecastHistorySection } from './ForecastHistorySection';
import { apiClient } from '@/api/client';

vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/unbound-method -- apiClient.get is a vi.fn mock, not a bound method
const mockGet = vi.mocked(apiClient.get);

function wireHistory(results: unknown[], cap: number | null = 100) {
  mockGet.mockResolvedValue({ data: { results, cap } } as never);
}

function wireHistoryEnvelope(envelope: Record<string, unknown>) {
  mockGet.mockResolvedValue({ data: envelope } as never);
}

const RUN_NEWEST = {
  id: 'r2',
  taken_at: '2026-06-06T14:14:00Z',
  p50: '2026-08-28',
  p80: '2026-09-15',
  p95: '2026-09-24',
  cpm_finish: '2026-09-10',
  n_simulations: 1000,
  task_count: 12,
  delta: { p50: 3, p80: 14, p95: 9 },
  triggered_by_name: null,
};
const RUN_OLDEST = {
  id: 'r1',
  taken_at: '2026-05-30T09:02:00Z',
  p50: '2026-08-25',
  p80: '2026-09-01',
  p95: '2026-09-15',
  cpm_finish: '2026-08-30',
  n_simulations: 1000,
  task_count: 12,
  delta: null,
  triggered_by_name: null,
};

describe('ForecastHistorySection', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('renders nothing when there is no history (never run)', async () => {
    wireHistory([]);
    const { container } = renderWithProviders(<ForecastHistorySection projectId="p1" />);
    // Loading shows a skeleton; once the empty result settles the section unmounts.
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('shows runs newest-first with the P80 delta', async () => {
    wireHistory([RUN_NEWEST, RUN_OLDEST]);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(await screen.findByText('2 runs · cap 100')).toBeInTheDocument();
    // Delta shown for the newest run.
    expect(screen.getByText('▲ +14d')).toBeInTheDocument();
  });

  it('exposes the delta to screen readers without relying on color', async () => {
    wireHistory([RUN_NEWEST, RUN_OLDEST]);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(await screen.findByText('P80 slipped 14 days later')).toBeInTheDocument();
  });

  it('marks the oldest run as the baseline (no delta)', async () => {
    wireHistory([RUN_NEWEST, RUN_OLDEST]);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(await screen.findByText('— baseline')).toBeInTheDocument();
  });

  it('shows a hint when only one run exists', async () => {
    wireHistory([{ ...RUN_OLDEST, delta: null }]);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(
      await screen.findByText(/Run again later to see how the forecast moves/i),
    ).toBeInTheDocument();
  });

  it('renders the run-author attribution only when provided (Admin/Owner)', async () => {
    wireHistory([{ ...RUN_NEWEST, triggered_by_name: 'Kelly Hair' }, RUN_OLDEST]);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(await screen.findByText(/run by Kelly Hair/i)).toBeInTheDocument();
  });

  it('shows an error state with a retry affordance', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn.t load forecast history/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('flags when the retention cap is reached', async () => {
    const runs = Array.from({ length: 3 }, (_, i) => ({ ...RUN_NEWEST, id: `c${i}`, delta: null }));
    wireHistory(runs, 3);
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(await screen.findByText('3 runs · cap reached')).toBeInTheDocument();
    expect(screen.getByText(/Older runs are trimmed/i)).toBeInTheDocument();
  });

  it('collapses and expands on header click', async () => {
    wireHistory([RUN_NEWEST, RUN_OLDEST]);
    const user = userEvent.setup();
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    const toggle = await screen.findByRole('button', { name: /forecast history/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the "history turned off" note when the workspace disabled it (#1232)', async () => {
    // Envelope variant: enabled:false with an empty list — a quiet note, not a
    // broken empty shell.
    wireHistoryEnvelope({ results: [], cap: 100, enabled: false });
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    expect(
      await screen.findByText(/Run history is turned off for this workspace/i),
    ).toBeInTheDocument();
  });

  it('expands a past run to render its persisted distribution histogram (#1231)', async () => {
    // The first GET (no expand) lists runs; the row's "View distribution" GET
    // (?expand=distribution) returns the same run carrying a populated
    // distribution. Both go through the same mocked apiClient.get.
    const runWithDist = {
      ...RUN_NEWEST,
      distribution: {
        histogram_buckets: [
          { date: '2026-08-24', count: 200 },
          { date: '2026-08-31', count: 600 },
          { date: '2026-09-07', count: 200 },
        ],
        confidence_curve: [
          { date: '2026-08-24', pct: 0.2 },
          { date: '2026-09-07', pct: 1 },
        ],
        sensitivity: [{ task_id: 't1', index: 0.8 }],
      },
    };
    wireHistory([runWithDist, RUN_OLDEST]);
    const user = userEvent.setup();
    renderWithProviders(<ForecastHistorySection projectId="p1" />);
    const viewBtn = (await screen.findAllByRole('button', { name: /view distribution/i }))[0];
    await user.click(viewBtn);
    // The persisted distribution drives a real histogram (role="img" SVG with
    // the percentile label), not the cold-state prompt.
    await waitFor(() =>
      expect(
        screen.getByRole('img', { name: /Monte Carlo distribution\. P50/i }),
      ).toBeInTheDocument(),
    );
  });
});
