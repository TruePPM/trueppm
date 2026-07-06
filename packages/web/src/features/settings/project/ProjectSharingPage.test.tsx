import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectSharingPage } from './ProjectSharingPage';
import type { ShareLink } from '../hooks/useShareLinks';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/components/Toast', () => ({
  toast: {
    success: (m: string) => {
      toastSuccess(m);
    },
    error: (m: string) => {
      toastError(m);
    },
  },
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p-1' }));

const createMutate = vi.fn();
let createMutation: { mutate: typeof createMutate; isPending: boolean; error: unknown };
const revokeMutate = vi.fn();
let revokeMutation: { mutate: typeof revokeMutate; isPending: boolean; error: unknown };
let sharedLinksResult: { data: ShareLink[] | undefined; isLoading: boolean };

vi.mock('../hooks/useShareLinks', () => ({
  useShareLinks: () => sharedLinksResult,
  useCreateShareLink: () => createMutation,
  useRevokeShareLink: () => revokeMutation,
}));

function link(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: 'link-1',
    contentKind: 'board',
    tokenPrefix: 'sample-pfx-1',
    label: 'Client board',
    showAssignees: false,
    createdBy: 'Kelly',
    createdAt: '2026-07-06T00:00:00Z',
    revokedAt: null,
    accessCount: 3,
    lastAccessedAt: '2026-07-06T01:00:00Z',
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMutation = { mutate: createMutate, isPending: false, error: null };
  revokeMutation = { mutate: revokeMutate, isPending: false, error: null };
  sharedLinksResult = { data: [], isLoading: false };
});

describe('ProjectSharingPage (#283)', () => {
  it('shows the loading state', () => {
    sharedLinksResult = { data: undefined, isLoading: true };
    render(<ProjectSharingPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the empty state when there are no links', () => {
    render(<ProjectSharingPage />);
    expect(screen.getByText(/No share links yet/i)).toBeInTheDocument();
  });

  it('lists an active link with its label and access count', () => {
    sharedLinksResult = { data: [link()], isLoading: false };
    render(<ProjectSharingPage />);
    expect(screen.getByText('Client board')).toBeInTheDocument();
    expect(screen.getByText(/Viewed 3×/)).toBeInTheDocument();
    expect(screen.getByText(/names hidden/)).toBeInTheDocument();
  });

  it('creates a link and reveals the one-time token', async () => {
    const user = userEvent.setup();
    createMutate.mockImplementation(
      (_input, { onSuccess }: { onSuccess: (l: unknown) => void }) => {
        onSuccess({ ...link(), token: 'RAWTOKEN', sharePath: '/share/board/RAWTOKEN' });
      },
    );
    render(<ProjectSharingPage />);

    await user.click(screen.getByRole('button', { name: 'Create link…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create share link' });
    expect(dialog).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Label/), 'Client review board');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutate).toHaveBeenCalledWith(
      { label: 'Client review board', showAssignees: false },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );

    await waitFor(() =>
      expect(screen.getByText(/won.t be able to see it again/i)).toBeInTheDocument(),
    );
    const reveal = screen.getByLabelText<HTMLInputElement>('Public share link');
    expect(reveal.value).toContain('/share/board/RAWTOKEN');
  });

  it('does not discard the create dialog form when Cancel is clicked before minting', async () => {
    const user = userEvent.setup();
    render(<ProjectSharingPage />);

    await user.click(screen.getByRole('button', { name: 'Create link…' }));
    await screen.findByRole('dialog', { name: 'Create share link' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Create share link' })).not.toBeInTheDocument(),
    );
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('revokes a link after confirmation', async () => {
    const user = userEvent.setup();
    revokeMutate.mockImplementation((_id, { onSuccess }: { onSuccess: () => void }) => onSuccess());
    sharedLinksResult = { data: [link()], isLoading: false };
    render(<ProjectSharingPage />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(revokeMutate).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(toastSuccess).toHaveBeenCalledWith('Share link revoked');
  });

  it('cancels a pending revoke without mutating', async () => {
    const user = userEvent.setup();
    sharedLinksResult = { data: [link()], isLoading: false };
    render(<ProjectSharingPage />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revokeMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});
