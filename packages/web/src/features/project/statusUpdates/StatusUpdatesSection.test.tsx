import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusUpdate } from '@/api/types';
import { StatusUpdatesSection } from './StatusUpdatesSection';
import { draftKey, loadDraft } from './statusUpdateModel';
import { SNAPSHOT } from './statusUpdateFixtures';

const h = vi.hoisted(() => ({
  list: [] as unknown[],
  post: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  online: true,
  fail: false,
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: () =>
      h.fail
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({
            data: { count: h.list.length, next: null, previous: null, results: h.list },
          }),
    post: (...args: unknown[]) => h.post(...args),
  },
}));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => h.online }));
vi.mock('@/features/shell2/useMinWidth', () => ({ useMinWidth: () => true }));

const UPDATE: StatusUpdate = {
  id: 'u1',
  project: 'p1',
  seq: 6,
  rag: 'amber',
  narrative: 'Vendor slipped\nmore',
  author: 1,
  author_name: 'Pat M',
  posted_at: '2026-11-20T09:00:00Z',
  computed_health: 'on_track',
  snapshot: SNAPSHOT,
  snapshot_sha256: 'x',
  snapshot_verified: true,
  live_diff: { 'forecast.p80': { value: '2026-12-14', as_of: null } },
};

function renderSection(canPost = true, derivedBand: string | null = null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StatusUpdatesSection
        projectId="p1"
        userId="7"
        canPost={canPost}
        liveRows={[]}
        derivedBand={derivedBand}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.list = [];
  h.post.mockReset();
  h.online = true;
  h.fail = false;
});
afterEach(() => window.localStorage.clear());

describe('StatusUpdatesSection', () => {
  it('empty state offers the one action, only to a PM', async () => {
    renderSection();
    expect(await screen.findByText('No status updates yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post update' })).toBeInTheDocument();
  });

  it("the first update's composer still shows the plan's computed band", async () => {
    renderSection(true, 'at_risk');
    await userEvent.click(await screen.findByRole('button', { name: 'Post update' }));
    expect(await screen.findByText(/Computed:/)).toBeInTheDocument();
  });

  it('a reader sees the empty state with no action', async () => {
    renderSection(false);
    await screen.findByText('No status updates yet');
    expect(screen.queryByRole('button', { name: 'Post update' })).toBeNull();
  });

  it('history row opens the frozen snapshot with now tags from the API', async () => {
    h.list = [UPDATE];
    renderSection();
    const row = await screen.findByTestId('status-update-row');
    expect(row).toHaveTextContent('At risk');
    expect(row).toHaveTextContent('Vendor slipped');
    expect(row).toHaveTextContent('Pat M');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('snapshot-now-forecast.p80')).toHaveTextContent(/now/);
    expect(screen.getByText(/A correction is a new update/)).toBeInTheDocument();
  });

  it('a failed post keeps the call and narrative as a draft and names the update', async () => {
    h.list = [UPDATE];
    h.post.mockRejectedValue(new Error('boom'));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Post update' }));
    expect(screen.getByTestId('status-composer-computed')).toHaveTextContent('On track');
    await userEvent.click(screen.getByRole('radio', { name: /Critical/ }));
    await userEvent.type(screen.getByTestId('status-composer-narrative'), 'Late');
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    expect(await screen.findByTestId('status-composer-error')).toHaveTextContent(
      'Update 7 didn’t post; your call and narrative are kept as a draft.',
    );
    expect(loadDraft('p1', '7')).toMatchObject({ rag: 'red', narrative: 'Late' });
  });

  it('offline: post is disabled with the reconnect line; the draft is kept', async () => {
    h.online = false;
    window.localStorage.setItem(
      draftKey('p1', '7'),
      JSON.stringify({ rag: 'green', narrative: 'ok', savedAt: '' }),
    );
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Resume draft' }));
    expect(screen.getByRole('radio', { name: /On track/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Post update' })).toBeDisabled();
    expect(screen.getByTestId('status-composer-offline')).toHaveTextContent(
      'Posts when you reconnect; the snapshot freezes then.',
    );
  });

  it('a successful post clears the draft and closes the composer', async () => {
    h.post.mockResolvedValue({ data: UPDATE });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Post update' }));
    await userEvent.click(screen.getByRole('radio', { name: /On track/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => expect(screen.queryByTestId('status-composer')).toBeNull());
    expect(h.post).toHaveBeenCalledWith(
      '/projects/p1/status-updates/',
      { rag: 'green', narrative: '' },
      { headers: { 'Idempotency-Key': expect.stringMatching(/.+/) as string } },
    );
    expect(loadDraft('p1', '7')).toBeNull();
  });

  it('a retry of the same call reuses its Idempotency-Key; an edit mints a new one', async () => {
    h.post.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Post update' }));
    await userEvent.click(screen.getByRole('radio', { name: /On track/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await screen.findByTestId('status-composer-error');
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    const key = (i: number) =>
      (h.post.mock.calls[i][2] as { headers: Record<string, string> }).headers['Idempotency-Key'];
    expect(key(1)).toBe(key(0));
    h.post.mockResolvedValue({ data: UPDATE });
    await userEvent.type(screen.getByTestId('status-composer-narrative'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(3));
    expect(key(2)).not.toBe(key(0));
  });

  it('an archived project offers no Post and says why', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <StatusUpdatesSection projectId="p1" userId="7" canPost archived liveRows={[]} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('status-updates-archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post update' })).toBeNull();
  });

  it('a saved draft stays reachable when the history read fails', async () => {
    h.fail = true;
    window.localStorage.setItem(
      draftKey('p1', '7'),
      JSON.stringify({ rag: 'green', narrative: 'ok', savedAt: '' }),
    );
    renderSection();
    expect(await screen.findByText('Status updates didn’t load')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(screen.getByRole('radio', { name: /On track/ })).toBeChecked();
  });
});
