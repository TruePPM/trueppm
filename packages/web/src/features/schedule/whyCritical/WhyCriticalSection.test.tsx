import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrivingChainNode, ScheduleDrivingChain } from '@/api/types';
import { axiosNetworkError, axiosRefusal } from '@/test/axiosError';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { WhyCriticalSection } from './WhyCriticalSection';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function node(p: Partial<DrivingChainNode> & { task_id: string; name: string }): DrivingChainNode {
  return {
    status: 'NOT_STARTED',
    direction: 'upstream',
    hops: 1,
    early_start: '2027-03-08',
    early_finish: '2027-03-12',
    total_float: { value: 0, unit: 'working_days' },
    band: 'critical',
    is_critical: true,
    is_project_finish: false,
    sprint: null,
    ...p,
  };
}

function chain(selfBand = 'critical'): ScheduleDrivingChain {
  return {
    schema_version: 1,
    project_id: 'p1',
    task_id: 'frame',
    computable: true,
    reason: null,
    project_finish: '2027-06-02',
    depth: 3,
    node_cap: 50,
    truncated: false,
    truncated_reason: null,
    total_links: 1,
    omitted_non_driving_count: 0,
    near_critical_threshold: { value: 10, unit: 'working_days' },
    calendar_id: null,
    nodes: [
      node({
        task_id: 'frame',
        name: 'Frame walls',
        direction: 'self',
        hops: 0,
        early_finish: '2027-03-19',
        band: selfBand,
        is_critical: selfBand === 'critical',
        total_float: { value: selfBand === 'ample' ? 30 : 0, unit: 'working_days' },
      }),
      node({ task_id: 'pour', name: 'Pour foundation' }),
    ],
    edges: [
      {
        predecessor_id: 'pour',
        successor_id: 'frame',
        dep_type: 'FS',
        lag: { value: 0, unit: 'calendar_days' },
        is_driving: true,
        via_summary: null,
      },
    ],
    _provenance: {
      schema_version: 1,
      engine_version: '0.5.0',
      api_version: '1',
      input_hash: 'sha256:0f',
      computed_at: '2027-03-02T14:02:00Z',
    },
  } as ScheduleDrivingChain;
}

function ok(body: unknown) {
  return Promise.resolve({ data: body } as AxiosResponse);
}

function throttled(seconds: string) {
  const err = axiosRefusal(429, { detail: 'throttled' });
  (err.response as AxiosResponse).headers = { 'retry-after': seconds };
  return err;
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WhyCriticalSection projectId="p1" taskId="frame" taskHasSprint={false} focusNonce={0} wide />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  try {
    window.localStorage.setItem('tppm:whyCritical:detailOpen', '1');
  } catch {
    // storage blocked: the disclosure tests open it by click instead
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WhyCriticalSection states (#4892)', () => {
  it('429: counts down from Retry-After, announces readiness, never retries on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMock.mockRejectedValue(throttled('2'));
    renderSection();
    expect(
      await screen.findByText(
        'This takes a lot of computing, and too many requests came in at once.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('No automatic retry.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again in 2 s' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.getByText('Ready to try again.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    getMock.mockImplementation(() => ok(chain()));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it('offline: says a connection is needed', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    getMock.mockRejectedValue(axiosNetworkError());
    renderSection();
    expect(await screen.findByText("You're offline. This needs a connection.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Copy as text: success reads "Copied" and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    getMock.mockImplementation(() => ok(chain()));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy as text' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByText('Copied to clipboard as plain text.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('WHY CRITICAL: Frame walls'));
  });

  it('Copy as text: a clipboard failure falls back to a selectable textarea', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    getMock.mockImplementation(() => ok(chain()));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy as text' }));
    expect(
      await screen.findByText("Couldn't copy. Select the text below and copy it."),
    ).toBeInTheDocument();
    const area = screen.getByRole('textbox', { name: 'Why critical as text' });
    expect((area as HTMLTextAreaElement).value).toContain('WHY CRITICAL: Frame walls');
  });

  it('a failed refresh keeps the existing content, dimmed, under the error', async () => {
    getMock.mockImplementationOnce(() => ok(chain()));
    renderSection();
    expect(await screen.findByText(/Can't start until/)).toBeInTheDocument();
    getMock.mockRejectedValueOnce(axiosRefusal(500, { detail: 'boom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh why critical' }));
    expect(
      await screen.findByText(/^Couldn't update\. Showing the schedule computed/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Can't start until/)).toBeInTheDocument();
    expect(screen.getByTestId('why-critical-content')).toHaveClass('opacity-[0.55]');
  });

  it('a schedule recompute marks it stale and refetches once after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMock.mockImplementationOnce(() => ok(chain()));
    renderSection();
    expect(await screen.findByText(/Can't start until/)).toBeInTheDocument();
    let release: (v: AxiosResponse) => void = () => {};
    getMock.mockImplementationOnce(
      () =>
        new Promise<AxiosResponse>((r) => {
          release = r;
        }),
    );
    act(() => useSchedulerStore.getState().setCpmComplete('2027-03-02T15:00:00Z'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Schedule changed · updating…')).toBeInTheDocument();
    expect(screen.getByTestId('why-critical-content')).toHaveClass('opacity-[0.55]');
    await act(async () => {
      release({ data: chain() } as AxiosResponse);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByText('Schedule changed · updating…')).not.toBeInTheDocument();
  });

  it('R6: a recompute that drops the band changes the section in place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMock.mockImplementationOnce(() => ok(chain()));
    renderSection();
    expect(await screen.findByText(/Can't start until/)).toBeInTheDocument();
    getMock.mockImplementationOnce(() => ok(chain('ample')));
    act(() => useSchedulerStore.getState().setCpmComplete('2027-03-02T16:00:00Z'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(
      await screen.findByText(
        'After the latest schedule update, this task is no longer critical or near-critical.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Why critical' })).toBeInTheDocument();
  });
});
