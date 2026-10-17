import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { ProgramScheduleLiveSync } from './ProgramScheduleLiveSync';

// Synchronous thenable so the socket is created inside connect() and each
// assertion can count sockets without awaiting the ticket round-trip. Every
// resolved mint opens exactly one socket, so the socket count is the mint count.
vi.mock('@/api/wsTicket', () => ({
  fetchWsTicket: () => ({
    then(onFulfilled: (t: string) => void) {
      onFulfilled('test-ticket');
      return this;
    },
    catch() {
      return this;
    },
  }),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }

  dispatch(type: string, event: unknown) {
    (this.listeners[type] ?? []).forEach((cb) => {
      cb(event);
    });
  }
}

function socketsFor(projectId: string): MockWebSocket[] {
  return MockWebSocket.instances.filter((ws) => ws.url.includes(`/projects/${projectId}/`));
}

describe('ProgramScheduleLiveSync — per-project close codes (#4375)', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — overriding WebSocket for the test environment
    globalThis.WebSocket = MockWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: 'tok', isAuthenticated: true, sessionExpired: false });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    act(() => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false, sessionExpired: false });
    });
  });

  function mount(projectIds: string[], qc: QueryClient = new QueryClient()) {
    return render(
      <QueryClientProvider client={qc}>
        <ProgramScheduleLiveSync programId="prog-1" projectIds={projectIds} />
      </QueryClientProvider>,
    );
  }

  it('coalesces events from every member project into one refetch per window (#2839)', () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    mount(['proj-a', 'proj-b', 'proj-c'], qc);
    const frame = { data: JSON.stringify({ event_type: 'task_updated' }) };
    act(() => {
      for (const id of ['proj-a', 'proj-b', 'proj-c']) socketsFor(id)[0].dispatch('message', frame);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Three channels, one window: exactly one refetch, not one per channel.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs', 'prog-1', 'schedule'] });

    // A later window refetches again.
    act(() => {
      socketsFor('proj-b')[0].dispatch('message', frame);
      vi.advanceTimersByTime(300);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores events that cannot move the schedule', () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    mount(['proj-a'], qc);
    act(() => {
      socketsFor('proj-a')[0].dispatch('message', {
        data: JSON.stringify({ event_type: 'comment_created' }),
      });
      vi.advanceTimersByTime(1_000);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('a 4003 on one member project is terminal for that project only', () => {
    mount(['viewer-proj', 'member-proj']);
    expect(socketsFor('viewer-proj')).toHaveLength(1);
    expect(socketsFor('member-proj')).toHaveLength(1);

    act(() => {
      const [refused] = socketsFor('viewer-proj');
      refused.dispatch('open', {});
      refused.dispatch('close', { code: 4003 });
    });
    // Far past the 30 s backoff cap: the refused project is never re-dialed.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(socketsFor('viewer-proj')).toHaveLength(1);
    // The healthy sibling channel is untouched.
    expect(socketsFor('member-proj')).toHaveLength(1);
  });

  it('a refusal survives a token refresh: the refused project is not re-dialed', () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    mount(['viewer-proj', 'member-proj'], qc);
    act(() => {
      const [refused] = socketsFor('viewer-proj');
      refused.dispatch('open', {});
      refused.dispatch('close', { code: 4003 });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs', 'prog-1', 'schedule'] });

    // A new access token re-runs every channel's effect (15-minute token life).
    act(() => {
      useAuthStore.setState({ accessToken: 'tok-refreshed' });
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(socketsFor('viewer-proj')).toHaveLength(1);
    // The healthy channel does reconnect on the new token, as before.
    expect(socketsFor('member-proj')).toHaveLength(2);
  });

  it('negative control: a 1006 drop still reconnects with backoff', () => {
    mount(['proj-a']);
    act(() => {
      socketsFor('proj-a')[0].dispatch('close', { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(socketsFor('proj-a')).toHaveLength(2);
  });

  it('a first 4001 re-mints once; a second in a row stops', () => {
    mount(['proj-a']);
    act(() => {
      socketsFor('proj-a')[0].dispatch('open', {});
      socketsFor('proj-a')[0].dispatch('close', { code: 4001 });
    });
    // Re-minted immediately (an aged ticket is not an expired session).
    expect(socketsFor('proj-a')).toHaveLength(2);
    act(() => {
      socketsFor('proj-a')[1].dispatch('open', {});
      socketsFor('proj-a')[1].dispatch('close', { code: 4001 });
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(socketsFor('proj-a')).toHaveLength(2);
  });

  it('a socket that delivered a frame earns a fresh re-mint on a later 4001', () => {
    mount(['proj-a']);
    act(() => {
      socketsFor('proj-a')[0].dispatch('close', { code: 4001 });
    });
    act(() => {
      const live = socketsFor('proj-a')[1];
      live.dispatch('open', {});
      live.dispatch('message', { data: JSON.stringify({ event_type: 'presence_join' }) });
      live.dispatch('close', { code: 4001 });
    });
    expect(socketsFor('proj-a')).toHaveLength(3);
  });
});
