/**
 * `useDemoAccessGate` — the email-capture disclosure's read path (ADR-1197 D8, #3969).
 *
 * Every case below except the first is a case where the hook must return `null`. That
 * is deliberate: the disclosure is required to be conditional, so "says nothing" is
 * the behavior under test, not the uninteresting default. A hook that returned a
 * truthy value on an unresolved, failed, or ungated read would publish a claim about
 * PII collection that no deployment ever made.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return { ...actual, default: { ...actual.default, get: getMock } };
});

import { useDemoAccessGate } from './useEdition';

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useDemoAccessGate', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('surfaces a declared gate verbatim', async () => {
    const gate = { provider: 'Cloudflare Access', privacy_url: 'https://example.com/p' };
    getMock.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_access_gate: gate },
    });
    const { result } = renderHook(() => useDemoAccessGate(), {
      wrapper: makeWrapper(newClient()),
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual(gate);
  });

  it('passes the provider through unchanged rather than mapping it to a known vendor', async () => {
    // A demo behind Authelia must not publish a notice naming Cloudflare.
    getMock.mockResolvedValue({
      data: {
        edition: 'community',
        demo_read_only: true,
        demo_access_gate: { provider: 'Authelia', privacy_url: null },
      },
    });
    const { result } = renderHook(() => useDemoAccessGate(), {
      wrapper: makeWrapper(newClient()),
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.provider).toBe('Authelia');
    expect(result.current?.privacy_url).toBeNull();
  });

  it('is null in demo mode when no gate is declared', async () => {
    getMock.mockResolvedValue({
      data: { edition: 'community', demo_read_only: true, demo_access_gate: null },
    });
    const { result } = renderHook(() => useDemoAccessGate(), {
      wrapper: makeWrapper(newClient()),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('is null on a server that omits the field entirely', async () => {
    getMock.mockResolvedValue({ data: { edition: 'community' } });
    const { result } = renderHook(() => useDemoAccessGate(), {
      wrapper: makeWrapper(newClient()),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>'])(
    'drops a non-http(s) privacy_url (%s) but keeps the notice',
    async (url) => {
      // The chart and the API both refuse this, but an operator setting
      // DEMO_ACCESS_GATE in their own settings module bypasses both — and this hook
      // is on the only path that actually renders the href.
      getMock.mockResolvedValue({
        data: {
          edition: 'community',
          demo_read_only: true,
          demo_access_gate: { provider: 'Cloudflare Access', privacy_url: url },
        },
      });
      const { result } = renderHook(() => useDemoAccessGate(), {
        wrapper: makeWrapper(newClient()),
      });
      await waitFor(() => expect(result.current).not.toBeNull());
      // The disclosure is the part that matters; only the link is dropped.
      expect(result.current?.provider).toBe('Cloudflare Access');
      expect(result.current?.privacy_url).toBeNull();
    },
  );

  it('is null when the edition read fails', async () => {
    // A disclosure we cannot confirm must not be invented. Matches useDemoMode's
    // handling of the same failure: collapse to "nothing to say".
    getMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDemoAccessGate(), {
      wrapper: makeWrapper(newClient()),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
