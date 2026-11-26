import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadStatusUpdatePdf,
  statusUpdatePdfFilename,
  useCreateStatusUpdateShareLink,
} from './useStatusUpdates';

const h = vi.hoisted(() => ({
  get: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  post: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => h.get(...args),
    post: (...args: unknown[]) => h.post(...args),
  },
}));

afterEach(() => vi.clearAllMocks());

describe('statusUpdatePdfFilename', () => {
  it('names the file by code, number and size, and strips unsafe characters', () => {
    expect(statusUpdatePdfFilename(4, 'a4', 'RIV')).toBe('RIV-status-update-4-a4.pdf');
    expect(statusUpdatePdfFilename(4, 'letter', '../x y')).toBe('xy-status-update-4-letter.pdf');
    expect(statusUpdatePdfFilename(4, 'letter', null)).toBe('project-status-update-4-letter.pdf');
  });
});

describe('downloadStatusUpdatePdf', () => {
  it('fetches the PDF through the session client as a blob and saves it', async () => {
    h.get.mockResolvedValue({ data: new Blob(['%PDF-1.4']) });
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadStatusUpdatePdf('p1', { id: 'u1', seq: 3 }, 'a4', 'RIV');

    expect(h.get).toHaveBeenCalledWith('/projects/p1/status-updates/u1/pdf/', {
      params: { size: 'a4' },
      responseType: 'blob',
    });
    expect(click).toHaveBeenCalledOnce();
    // Deferred past the click, so the browser can still read the URL.
    expect(revoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:x'));
  });

  it('rejects when the server refuses, so the row can say so', async () => {
    h.get.mockRejectedValue(new Error('409'));
    await expect(downloadStatusUpdatePdf('p1', { id: 'u1', seq: 3 }, 'letter')).rejects.toThrow();
  });
});

describe('useCreateStatusUpdateShareLink', () => {
  it('mints a status-update link bound to the update, expiring, reveals opt-in', async () => {
    h.post.mockResolvedValue({
      data: {
        id: 'l1',
        share_path: '/share/status-update/tok',
        expires_at: '2026-12-25T00:00:00Z',
      },
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateStatusUpdateShareLink('p1'), { wrapper });
    result.current.mutate({
      updateId: 'u1',
      expiresInDays: 30,
      showRisks: true,
      showDecisions: false,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, body] = h.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/projects/p1/share-links/');
    expect(body).toMatchObject({
      content_kind: 'status_update',
      status_update: 'u1',
      show_risks: true,
      show_decisions: false,
    });
    expect(Date.parse(body.expires_at as string)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(body).not.toHaveProperty('show_assignees');
    expect(result.current.data?.share_path).toBe('/share/status-update/tok');
  });

  it("invalidates the project's share-links list so the new link can be revoked at once", async () => {
    h.post.mockResolvedValue({ data: { id: 'l1', share_path: '/share/status-update/tok' } });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateStatusUpdateShareLink('p1'), { wrapper });
    result.current.mutate({
      updateId: 'u1',
      expiresInDays: 7,
      showRisks: false,
      showDecisions: false,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['share-links', 'p1'] });
  });
});
