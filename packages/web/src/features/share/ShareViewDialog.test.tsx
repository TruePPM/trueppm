import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShareLink } from '@/features/settings/hooks/useShareLinks';

// The manage-row "Copy" honesty fix (#2163): after creation only the token
// PREFIX survives, so a manage-row copy can never reproduce a working link. The
// button must copy the bare reference fragment (no origin) and toast honestly —
// never the same "Link copied" as the genuine reveal-step copy.

const mockUseShareLinks = vi.fn<() => { data: ShareLink[]; isLoading: boolean }>();
const mockRevokeMutate = vi.fn();
vi.mock('@/features/settings/hooks/useShareLinks', () => ({
  useShareLinks: () => mockUseShareLinks(),
  useCreateShareLink: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRevokeShareLink: () => ({ mutate: mockRevokeMutate, isPending: false }),
}));

const toastInfo = vi.fn<(m: string) => void>();
const toastSuccess = vi.fn<(m: string) => void>();
const toastError = vi.fn<(m: string) => void>();
vi.mock('@/components/Toast', () => ({
  toast: {
    info: (m: string) => {
      toastInfo(m);
    },
    success: (m: string) => {
      toastSuccess(m);
    },
    error: (m: string) => {
      toastError(m);
    },
  },
}));

vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({ formatInstantDate: (iso: string) => iso }),
}));

import { ShareViewDialog } from './ShareViewDialog';

const LINK: ShareLink = {
  id: 'link-1',
  contentKind: 'board',
  tokenPrefix: 'abcd1234',
  label: 'Stakeholder view',
  showAssignees: false,
  createdBy: 'user-1',
  createdAt: '2026-07-01T12:00:00Z',
  expiresAt: null,
  revokedAt: null,
  accessCount: 3,
  lastAccessedAt: '2026-07-10T12:00:00Z',
  isActive: true,
  isExpired: false,
};

describe('ShareViewDialog — manage-row Copy honesty (#2163)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockUseShareLinks.mockReturnValue({ data: [LINK], isLoading: false });
  });

  it('labels the manage-row button "Copy ID", not "Copy"', async () => {
    render(<ShareViewDialog projectId="p1" contentKind="board" onClose={vi.fn()} />);
    // The dialog lands on Manage when active links exist.
    const copy = await screen.findByRole('button', { name: /copy id/i });
    expect(copy).toBeInTheDocument();
    // The bare, misleading "Copy" affordance is gone.
    expect(screen.queryByRole('button', { name: /^Copy$/ })).toBeNull();
  });

  it('copies the bare reference fragment — no origin, so it never reads as a link', async () => {
    render(<ShareViewDialog projectId="p1" contentKind="board" onClose={vi.fn()} />);
    const copy = await screen.findByRole('button', { name: /copy id/i });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('share/board/abcd1234');
    // Never the full origin URL that the old code wrote.
    expect(writeText.mock.calls[0][0]).not.toContain('http');
  });

  it('toasts an honest, distinct message — never the reveal step\'s "Link copied"', async () => {
    render(<ShareViewDialog projectId="p1" contentKind="board" onClose={vi.fn()} />);
    const copy = await screen.findByRole('button', { name: /copy id/i });
    fireEvent.click(copy);
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo.mock.calls[0][0]).toMatch(/reference copied/i);
    expect(toastInfo.mock.calls[0][0]).toMatch(/only shown at creation/i);
    expect(toastSuccess).not.toHaveBeenCalledWith('Link copied');
  });
});
