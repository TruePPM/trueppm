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
    expiresAt: null,
    revokedAt: null,
    accessCount: 3,
    lastAccessedAt: '2026-07-06T01:00:00Z',
    isActive: true,
    isExpired: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMutation = { mutate: createMutate, isPending: false, error: null };
  revokeMutation = { mutate: revokeMutate, isPending: false, error: null };
  sharedLinksResult = { data: [], isLoading: false };
});

describe('ProjectSharingPage (#283 / #1486)', () => {
  it('shows the loading state', () => {
    sharedLinksResult = { data: undefined, isLoading: true };
    render(<ProjectSharingPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the empty state when there are no links', () => {
    render(<ProjectSharingPage />);
    expect(screen.getByText(/No share links yet/i)).toBeInTheDocument();
  });

  it('groups active links by kind with a count and expiry clause', () => {
    sharedLinksResult = {
      data: [
        link({ id: 'b1', contentKind: 'board', label: 'Vendor board' }),
        link({
          id: 's1',
          contentKind: 'schedule',
          label: 'Client review',
          expiresAt: '2026-08-05T00:00:00Z',
        }),
      ],
      isLoading: false,
    };
    render(<ProjectSharingPage />);
    expect(screen.getByText(/Schedule links/)).toBeInTheDocument();
    expect(screen.getByText(/Board links/)).toBeInTheDocument();
    expect(screen.getByText('Vendor board')).toBeInTheDocument();
    expect(screen.getByText('Client review')).toBeInTheDocument();
    // The schedule link carries an expiry clause, the board link does not.
    expect(screen.getByText(/expires in/)).toBeInTheDocument();
    expect(screen.getByText(/never expires/)).toBeInTheDocument();
  });

  it('creates a schedule link (with a content kind + expiry) and reveals the one-time token', async () => {
    const user = userEvent.setup();
    createMutate.mockImplementation(
      (_input, { onSuccess }: { onSuccess: (l: unknown) => void }) => {
        onSuccess({
          ...link({ contentKind: 'schedule' }),
          token: 'RAWTOKEN',
          sharePath: '/share/schedule/RAWTOKEN',
        });
      },
    );
    render(<ProjectSharingPage />);

    await user.click(screen.getByRole('button', { name: 'Create link…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share this schedule' });
    expect(dialog).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Label/), 'Client review');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Client review',
        showAssignees: false,
        contentKind: 'schedule',
        // Default nudge is a 30-day expiry (a computed ISO timestamp).
        expiresAt: expect.any(String) as unknown,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );

    await waitFor(() =>
      expect(screen.getByText(/won.t be able to see it again/i)).toBeInTheDocument(),
    );
    const reveal = screen.getByLabelText<HTMLInputElement>('Public share link');
    expect(reveal.value).toContain('/share/schedule/RAWTOKEN');
  });

  it('can pick "Never" so the minted link has no expiry', async () => {
    const user = userEvent.setup();
    render(<ProjectSharingPage />);
    await user.click(screen.getByRole('button', { name: 'Create link…' }));
    await screen.findByRole('dialog', { name: 'Share this schedule' });

    await user.click(screen.getByRole('button', { name: 'Never' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ contentKind: 'schedule', expiresAt: null }),
      expect.anything(),
    );
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
