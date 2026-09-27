import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  gitAutomationKey,
  useGitAutomationConfig,
  useRotateGitAutomationSecret,
  useUpdateGitAutomation,
  type GitAutomationConfig,
} from './useGitAutomation';

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('@/api', () => ({ apiClient: { get: getMock, put: putMock, post: postMock } }));

const CONFIG: GitAutomationConfig = {
  enabled: false,
  secret_set: false,
  webhook_url: 'https://app.test/api/v1/integrations/git/p1/',
  configured_by: null,
  secret_set_at: null,
  updated_at: '2026-04-01T00:00:00Z',
};

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, putMock, postMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('useGitAutomationConfig', () => {
  it('reads the project config and is idle without a project', async () => {
    getMock.mockResolvedValue({ data: CONFIG });
    const { result } = renderHook(() => useGitAutomationConfig('p1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(CONFIG));
    expect(getMock).toHaveBeenCalledWith('/integrations/projects/p1/git-automation/');
    const { result: idle } = renderHook(() => useGitAutomationConfig(null), { wrapper });
    expect(idle.current.fetchStatus).toBe('idle');
    expect(gitAutomationKey('p1')).toEqual(['git-automation', 'p1']);
  });
});

describe('useUpdateGitAutomation', () => {
  it('PUTs the toggle, seeds the cache from the response, then reconciles', async () => {
    putMock.mockResolvedValue({ data: { ...CONFIG, enabled: true } });
    const { result } = renderHook(() => useUpdateGitAutomation('p1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ enabled: true });
    });
    expect(putMock).toHaveBeenCalledWith('/integrations/projects/p1/git-automation/', {
      enabled: true,
    });
    expect(qc.getQueryData<GitAutomationConfig>(['git-automation', 'p1'])?.enabled).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['git-automation', 'p1'] });
  });
});

describe('useRotateGitAutomationSecret', () => {
  it('posts to rotate-secret, hands back the one-time plaintext and refetches the config', async () => {
    postMock.mockResolvedValue({
      data: {
        secret: 'whs_once',
        webhook_url: CONFIG.webhook_url,
        secret_set_at: '2026-04-02T00:00:00Z',
      },
    });
    const { result } = renderHook(() => useRotateGitAutomationSecret('p1'), { wrapper });
    let rotated: { secret: string } | undefined;
    await act(async () => {
      rotated = await result.current.mutateAsync();
    });
    expect(postMock).toHaveBeenCalledWith(
      '/integrations/projects/p1/git-automation/rotate-secret/',
    );
    expect(rotated?.secret).toBe('whs_once');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['git-automation', 'p1'] });
  });
});
