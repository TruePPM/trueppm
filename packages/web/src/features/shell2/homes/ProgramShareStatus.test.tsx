import { fireEvent, screen, within } from '@testing-library/react';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProgramShareStatus } from './ProgramShareStatus';

const h = vi.hoisted(() => ({
  byProject: {} as Record<string, Record<string, unknown>>,
  revoke: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@/features/settings/hooks/useShareLinks', () => ({
  useShareLinks: (id: string) => h.byProject[id],
  useRevokeShareLink: () => ({ mutate: h.revoke, isPending: false }),
}));

const rows = [
  { id: 'p1', name: 'Atlas', to: '/p/1', health: null, atRisk: 0, overdue: 0 },
  { id: 'p2', name: 'Borealis', to: '/p/2', health: null, atRisk: 0, overdue: 0 },
];
const link = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  contentKind: 'board',
  tokenPrefix: 'abc123',
  label: 'Client review',
  isActive: true,
  expiresAt: null,
  accessCount: 3,
  ...over,
});
const ok = (data: unknown[]) => ({ data, isLoading: false, error: null, refetch: h.refetch });

beforeEach(() => {
  h.revoke.mockClear();
  h.byProject = { p1: ok([link()]), p2: ok([]) };
});

describe('ProgramShareStatus', () => {
  it('lists each project with its live links and says so when one is not shared', () => {
    renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    expect(screen.getByText('Client review')).toBeTruthy();
    expect(screen.getByText('Board · never expires · 3 views')).toBeTruthy();
    expect(screen.getByText('Not shared.')).toBeTruthy();
  });

  it('hides a revoked or expired link', () => {
    h.byProject = { p1: ok([link({ isActive: false })]), p2: ok([]) };
    renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    expect(screen.queryByText('Client review')).toBeNull();
  });

  it('revokes only after a second, named confirmation', () => {
    renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Client review on Atlas' }));
    expect(h.revoke).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Revoke Client review' });
    fireEvent.click(within(group).getByRole('button', { name: 'Revoke link' }));
    expect(h.revoke.mock.calls[0][0]).toBe('l1');
  });

  it('"Keep it" backs out without a write', () => {
    renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    fireEvent.click(screen.getByRole('button', { name: /^Revoke Client review/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(h.revoke).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Revoke Client review/ })).toBeTruthy();
  });

  it('loading, error with retry, and a non-admin 403 each read differently', () => {
    const forbidden = new AxiosError('no', '403', undefined, undefined, {
      status: 403,
    } as never);
    h.byProject = {
      p1: { data: undefined, isLoading: true, error: null, refetch: h.refetch },
      p2: { data: undefined, isLoading: false, error: new Error('boom'), refetch: h.refetch },
    };
    const { unmount } = renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    expect(screen.getByText("Couldn't load share links.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry|Try again/ }));
    expect(h.refetch).toHaveBeenCalled();
    unmount();
    h.byProject = {
      p1: { data: undefined, isLoading: false, error: forbidden, refetch: h.refetch },
      p2: ok([]),
    };
    renderWithRouter(<ProgramShareStatus rows={rows as never} />);
    expect(screen.getByText('Share links are visible to project admins only.')).toBeTruthy();
  });

  it('a program with no projects has an empty state, not an empty list', () => {
    renderWithRouter(<ProgramShareStatus rows={[]} />);
    expect(screen.getByText('This program has no projects to share yet.')).toBeTruthy();
  });
});
