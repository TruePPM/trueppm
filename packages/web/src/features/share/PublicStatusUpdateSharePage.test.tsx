import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicStatusUpdateSharePage } from './PublicStatusUpdateSharePage';
import { classifyStatusUpdateShareError, narrativeParagraphs } from './statusUpdateShareApi';
import type { PublicStatusUpdate } from './statusUpdateShareApi';

const h = vi.hoisted(() => ({
  get: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  wide: true,
}));

vi.mock('axios', async (orig) => {
  const actual = await orig<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: (...a: unknown[]) => h.get(...a) } };
});
vi.mock('@/features/shell2/useMinWidth', () => ({ useMinWidth: () => h.wide }));

const metric = <T,>(value: T) => ({ value, as_of: '2026-11-20T09:00:00Z', definition: 'def' });

const SHARE: PublicStatusUpdate = {
  content_kind: 'status_update',
  project: { name: 'Riverside', short_id: 'RIV' },
  seq: 4,
  rag: 'amber',
  narrative: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
  posted_at: '2026-11-20T09:00:00Z',
  author: null,
  computed_health: 'at_risk',
  as_of: '2026-11-20T09:00:00Z',
  forecast: {
    p50: metric('2026-12-01'),
    p80: metric('2026-12-07'),
    cpm_finish: metric('2026-11-28'),
    baseline_finish: '2026-12-01',
    baseline_finish_variance_days: metric(-3),
  },
  counts: { completed_since_previous: metric(2), slipped_since_previous: metric(1) },
  milestones: [
    { name: 'Beta', cpm_finish: '2026-12-01', baseline_finish: null, variance_days: null },
  ],
  risks: null,
  decisions: null,
  show_assignees: false,
  show_milestone_dates: true,
  show_risks: false,
  show_decisions: false,
};

function renderAt(token = 'tok') {
  return render(
    <MemoryRouter initialEntries={[`/share/status-update/${token}`]}>
      <Routes>
        <Route path="/share/status-update/:token" element={<PublicStatusUpdateSharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function axiosStatus(status: number) {
  return new AxiosError('x', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });
}

afterEach(() => {
  vi.clearAllMocks();
  h.wide = true;
});

describe('PublicStatusUpdateSharePage', () => {
  it('renders the frozen update read-only, with no link into the workspace', async () => {
    h.get.mockResolvedValue({ data: SHARE });
    const { container } = renderAt('a+b');
    expect(await screen.findByRole('heading', { name: 'Riverside' })).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith('/api/v1/share/status-update/a%2Bb/');
    expect(screen.getByTestId('share-read-only-chip')).toHaveTextContent('Read-only');
    expect(screen.getByTestId('share-call')).toHaveTextContent('At risk');
    expect(screen.getByText('Third paragraph.')).toBeInTheDocument();
    expect(screen.getByTestId('share-frozen-note')).toHaveTextContent('frozen when update 4');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );
  });

  it('truncates the narrative on a phone and reveals all paragraphs on request', async () => {
    h.wide = false;
    h.get.mockResolvedValue({ data: SHARE });
    renderAt();
    expect(await screen.findByText('First paragraph.')).toBeInTheDocument();
    expect(screen.queryByText('Third paragraph.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Read all 3 paragraphs' }));
    expect(screen.getByText('Third paragraph.')).toBeInTheDocument();
  });

  it('shows one not-available state for every unavailable token', async () => {
    h.get.mockRejectedValue(axiosStatus(404));
    renderAt('nope');
    expect(await screen.findByText('This link isn’t available')).toBeInTheDocument();
  });
});

describe('statusUpdateShareApi helpers', () => {
  it('classifies statuses', () => {
    expect(classifyStatusUpdateShareError(axiosStatus(404))).toBe('unavailable');
    expect(classifyStatusUpdateShareError(axiosStatus(410))).toBe('unavailable');
    expect(classifyStatusUpdateShareError(axiosStatus(429))).toBe('rate_limited');
    expect(classifyStatusUpdateShareError(new Error('x'))).toBe('error');
  });

  it('splits paragraphs and drops empties', () => {
    expect(narrativeParagraphs('a\n\n\nb\nc  \n')).toEqual(['a', 'b', 'c']);
    expect(narrativeParagraphs('   ')).toEqual([]);
  });
});
