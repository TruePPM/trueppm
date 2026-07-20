import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { ShareViewDialog } from './ShareViewDialog';
import type { ShareLink, CreatedShareLink } from '@/features/settings/hooks/useShareLinks';

const toastSuccess = vi.fn<(m: string) => void>();
const toastError = vi.fn<(m: string) => void>();
const toastInfo = vi.fn<(m: string) => void>();
vi.mock('@/components/Toast', () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: (m: string) => toastInfo(m),
  },
}));

// Distinctive sentinel so a spec can prove the reveal "Expires …" string is
// routed through the user's date-format preference (rule 257) — not a bare
// toLocaleDateString().
vi.mock('@/hooks/useUserDateFormat', () => ({
  useUserDateFormat: () => ({
    format: (iso: string) => `PREF[${iso}]`,
    formatInstant: (iso: string) => `PREF[${iso}]`,
    formatInstantDate: (iso: string) => `PREF[${iso}]`,
    formatInstantTime: (iso: string) => `PREF[${iso}]`,
  }),
}));

const createMutate = vi.fn();
let createMutation: { mutate: typeof createMutate; isPending: boolean; error: unknown };
const revokeMutate = vi.fn();
let revokeMutation: { mutate: typeof revokeMutate; isPending: boolean };
let sharedLinksResult: { data: ShareLink[] | undefined };

vi.mock('@/features/settings/hooks/useShareLinks', () => ({
  useShareLinks: () => sharedLinksResult,
  useCreateShareLink: () => createMutation,
  useRevokeShareLink: () => revokeMutation,
}));

const writeText = vi.fn().mockResolvedValue(undefined);

function link(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: 'link-1',
    contentKind: 'schedule',
    tokenPrefix: 'sample-pfx-1',
    label: 'Client review',
    showAssignees: false,
    createdBy: 'Kelly',
    createdAt: '2026-07-06T00:00:00Z',
    expiresAt: null,
    revokedAt: null,
    accessCount: 0,
    lastAccessedAt: null,
    isActive: true,
    isExpired: false,
    ...overrides,
  };
}

function created(overrides: Partial<CreatedShareLink> = {}): CreatedShareLink {
  return {
    ...link(),
    token: 'RAWTOKEN',
    sharePath: '/share/schedule/RAWTOKEN',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMutation = { mutate: createMutate, isPending: false, error: null };
  revokeMutation = { mutate: revokeMutate, isPending: false };
  sharedLinksResult = { data: [] };
  writeText.mockClear().mockResolvedValue(undefined);
  // Use defineProperty (not Object.assign) with configurable: true — in singleFork
  // mode a prior test file's userEvent.setup() installs a getter-only clipboard, and
  // Object.assign then throws "Cannot set property clipboard … which has only a getter".
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

function renderDialog(props: Partial<Parameters<typeof ShareViewDialog>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  renderWithProviders(
    <ShareViewDialog
      projectId="p-1"
      contentKind="schedule"
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

describe('ShareViewDialog — create mode', () => {
  it('starts in Create when there are no active links', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Share this schedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  });

  it('hides the kind selector when allowKindChoice is false (toolbar launch)', () => {
    renderDialog({ allowKindChoice: false });
    expect(screen.queryByRole('group', { name: 'What to share' })).not.toBeInTheDocument();
  });

  it('offers a Board/Schedule selector when allowKindChoice is true and switches the noun', async () => {
    const user = userEvent.setup();
    renderDialog({ allowKindChoice: true });
    expect(screen.getByRole('group', { name: 'What to share' })).toBeInTheDocument();
    // Default noun is schedule.
    expect(screen.getByRole('dialog', { name: 'Share this schedule' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'board' }));
    expect(screen.getByRole('dialog', { name: 'Share this board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'board' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('mints a link with the trimmed label, default 30-day expiry, and selected kind', async () => {
    const user = userEvent.setup();
    renderDialog({ allowKindChoice: true });
    await user.type(screen.getByLabelText(/Label/), '  Vendor review  ');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Vendor review',
        showAssignees: false,
        contentKind: 'schedule',
        expiresAt: expect.any(String) as unknown,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('sends expiresAt null when "Never" is chosen', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Never' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: null }),
      expect.anything(),
    );
  });

  it('sends showAssignees true when the checkbox is toggled on', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ showAssignees: true }),
      expect.anything(),
    );
  });

  it('requires a custom date before Create is enabled, then resolves it to an ISO expiry', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Pick date…' }));
    // With "custom" chosen but no date, the mint button is disabled.
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Expiry date'), { target: { value: '2027-01-15' } });
    const createBtn = screen.getByRole('button', { name: 'Create link' });
    expect(createBtn).toBeEnabled();
    await user.click(createBtn);
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date(Date.parse('2027-01-15T23:59:59Z')).toISOString(),
      }),
      expect.anything(),
    );
  });

  it('shows the server error detail when the mint fails', () => {
    createMutation = {
      mutate: createMutate,
      isPending: false,
      error: { isAxiosError: true, response: { data: { detail: 'Link cap reached' } } },
    };
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('Link cap reached');
  });

  it('shows no error alert when the failure is a non-axios error (no server detail)', () => {
    // errorDetail() returns null for a non-axios error, so the critical alert
    // paragraph is not rendered — the form stays in its normal state.
    createMutation = { mutate: createMutate, isPending: false, error: new Error('network down') };
    renderDialog();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
  });

  it('shows no error alert for an axios error that carries no detail string', () => {
    createMutation = {
      mutate: createMutate,
      isPending: false,
      error: { isAxiosError: true, response: { data: {} } },
    };
    renderDialog();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a "Creating…" busy label while the mint is pending', () => {
    createMutation = { mutate: createMutate, isPending: true, error: null };
    renderDialog();
    const btn = screen.getByRole('button', { name: 'Creating…' });
    expect(btn).toBeDisabled();
  });

  it('closes on backdrop pointer-down before a token is revealed', () => {
    const { onClose } = renderDialog();
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel returns to Manage when links exist, else closes', async () => {
    const user = userEvent.setup();
    // No links: Cancel closes.
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ShareViewDialog — reveal state', () => {
  function mintAndReveal(overrides: Partial<CreatedShareLink> = {}) {
    createMutate.mockImplementation(
      (_input, { onSuccess }: { onSuccess: (l: CreatedShareLink) => void }) => {
        onSuccess(created(overrides));
      },
    );
  }

  it('reveals the one-time link with a copy guard and preference-formatted expiry', async () => {
    const user = userEvent.setup();
    mintAndReveal({ expiresAt: '2026-08-05T00:00:00Z', showAssignees: true });
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByText(/won.t be able to see it again/i)).toBeInTheDocument();
    const reveal = screen.getByLabelText<HTMLInputElement>('Public share link');
    expect(reveal.value).toContain('/share/schedule/RAWTOKEN');
    // Expiry routed through the user preference hook, assignee-names branch = shown.
    expect(screen.getByText(/Expires PREF\[2026-08-05T00:00:00Z\]/)).toBeInTheDocument();
    expect(screen.getByText(/assignee names shown/)).toBeInTheDocument();
  });

  it('shows "Never expires" and hidden assignees for a non-expiring, private link', async () => {
    const user = userEvent.setup();
    mintAndReveal({ expiresAt: null, showAssignees: false });
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/won.t be able to see it again/i);
    expect(screen.getByText(/Never expires/)).toBeInTheDocument();
    expect(screen.getByText(/assignee names hidden/)).toBeInTheDocument();
  });

  it('copies the revealed link and toasts success', async () => {
    const user = userEvent.setup();
    // Reinstall our spy AFTER setup() — userEvent installs its own clipboard stub.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mintAndReveal();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/won.t be able to see it again/i);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/share/schedule/RAWTOKEN')));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link copied'));
  });

  it('toasts an error when the clipboard write is rejected', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockRejectedValueOnce(new Error('denied'));
    mintAndReveal();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/won.t be able to see it again/i);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not copy — select and copy manually'));
  });

  it('does NOT close on backdrop pointer-down once the token is revealed (copy guard)', async () => {
    const user = userEvent.setup();
    mintAndReveal();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/won.t be able to see it again/i);
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Done closes the dialog', async () => {
    const user = userEvent.setup();
    mintAndReveal();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/won.t be able to see it again/i);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ShareViewDialog — manage mode', () => {
  it('lands on Manage when active links already exist and lists them with a count', () => {
    sharedLinksResult = {
      data: [
        link({ id: 'a', label: 'Client review', accessCount: 0 }),
        link({ id: 'b', label: 'Vendor board', contentKind: 'schedule', accessCount: 2 }),
      ],
    };
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Shared schedule links' })).toBeInTheDocument();
    expect(screen.getByText('2 active. Revoking a link takes effect immediately.')).toBeInTheDocument();
    expect(screen.getByText('Client review')).toBeInTheDocument();
    expect(screen.getByText('Vendor board')).toBeInTheDocument();
  });

  it('filters the managed list by the active kind (revoked and other-kind links excluded)', () => {
    sharedLinksResult = {
      data: [
        link({ id: 'a', label: 'Schedule live', contentKind: 'schedule', isActive: true }),
        link({ id: 'b', label: 'Board link', contentKind: 'board', isActive: true }),
        link({ id: 'c', label: 'Schedule revoked', contentKind: 'schedule', isActive: false }),
      ],
    };
    renderDialog();
    expect(screen.getByText('Schedule live')).toBeInTheDocument();
    expect(screen.queryByText('Board link')).not.toBeInTheDocument();
    expect(screen.queryByText('Schedule revoked')).not.toBeInTheDocument();
  });

  it('"+ New link" switches to the create form, and Cancel returns to Manage', async () => {
    const user = userEvent.setup();
    sharedLinksResult = { data: [link({ label: 'Existing' })] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: '+ New link' }));
    expect(screen.getByRole('dialog', { name: 'Share this schedule' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Shared schedule links' })).toBeInTheDocument();
  });

  it('Close calls onClose from Manage', async () => {
    const user = userEvent.setup();
    sharedLinksResult = { data: [link()] };
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ShareViewDialog — CreatedLinkRow', () => {
  it('renders "Untitled link", never-expires, and hidden names for an unvisited link', () => {
    sharedLinksResult = { data: [link({ label: '', showAssignees: false, expiresAt: null, accessCount: 0 })] };
    renderDialog();
    expect(screen.getByText('Untitled link')).toBeInTheDocument();
    expect(screen.getByText('never expires')).toBeInTheDocument();
    expect(screen.getByText(/names hidden/)).toBeInTheDocument();
    expect(screen.getByText(/Viewed 0×/)).toBeInTheDocument();
    // No "last …" clause when never accessed.
    expect(screen.queryByText(/· last /)).not.toBeInTheDocument();
  });

  it('shows an expiry clause, shown-names, and a last-accessed relative time for a used link', () => {
    sharedLinksResult = {
      data: [
        link({
          label: 'Used link',
          showAssignees: true,
          expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          accessCount: 7,
          lastAccessedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        }),
      ],
    };
    renderDialog();
    expect(screen.getByText(/expires in 5d/)).toBeInTheDocument();
    expect(screen.getByText(/names shown/)).toBeInTheDocument();
    expect(screen.getByText(/Viewed 7×/)).toBeInTheDocument();
    expect(screen.getByText(/· last 3h ago/)).toBeInTheDocument();
  });

  it('renders "just now" for a link accessed less than a minute ago', () => {
    sharedLinksResult = {
      data: [link({ accessCount: 1, lastAccessedAt: new Date(Date.now() - 20_000).toISOString() })],
    };
    renderDialog();
    expect(screen.getByText(/· last just now/)).toBeInTheDocument();
  });

  it('renders a minutes-ago relative time for a recently accessed link', () => {
    sharedLinksResult = {
      data: [link({ accessCount: 4, lastAccessedAt: new Date(Date.now() - 12 * 60_000).toISOString() })],
    };
    renderDialog();
    expect(screen.getByText(/· last 12m ago/)).toBeInTheDocument();
  });

  it('renders a days-ago relative time for a link last accessed days ago', () => {
    sharedLinksResult = {
      data: [link({ accessCount: 9, lastAccessedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
    };
    renderDialog();
    expect(screen.getByText(/· last 3d ago/)).toBeInTheDocument();
  });

  it('renders "expired" for a link whose expiry is in the past', () => {
    sharedLinksResult = {
      data: [link({ expiresAt: new Date(Date.now() - 86_400_000).toISOString() })],
    };
    renderDialog();
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('renders "expires today" when the link expires within the day', () => {
    sharedLinksResult = {
      data: [link({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })],
    };
    renderDialog();
    expect(screen.getByText('expires today')).toBeInTheDocument();
  });

  it('copies the bare reference fragment and toasts honestly on the row Copy button (#2163)', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    sharedLinksResult = { data: [link({ tokenPrefix: 'abc123' })] };
    renderDialog();
    // #2163: the manage-row copy writes the bare reference (no origin, never a
    // working link) and toasts an honest, distinct message — not the reveal
    // step's "Link copied" success.
    await user.click(screen.getByRole('button', { name: /copy id/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('share/schedule/abc123'));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'Reference copied — the full link was only shown at creation',
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalledWith('Link copied');
  });

  it('toasts an error when the row copy is rejected', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockRejectedValueOnce(new Error('no'));
    sharedLinksResult = { data: [link()] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: /copy id/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not copy — select manually'),
    );
  });

  it('confirms a revoke: Revoke → Confirm calls the mutation and toasts success', async () => {
    const user = userEvent.setup();
    revokeMutate.mockImplementation((_id, { onSuccess }: { onSuccess: () => void }) => onSuccess());
    sharedLinksResult = { data: [link({ id: 'link-9' })] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(revokeMutate).toHaveBeenCalledWith(
      'link-9',
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
    expect(toastSuccess).toHaveBeenCalledWith('Share link revoked');
  });

  it('toasts an error when the revoke mutation fails', async () => {
    const user = userEvent.setup();
    revokeMutate.mockImplementation((_id, { onError }: { onError: () => void }) => onError());
    sharedLinksResult = { data: [link()] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(toastError).toHaveBeenCalledWith('Could not revoke — try again');
  });

  it('cancels a pending revoke without mutating', async () => {
    const user = userEvent.setup();
    sharedLinksResult = { data: [link()] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(revokeMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('shows a "Revoking…" busy label on a pending revoke', async () => {
    const user = userEvent.setup();
    revokeMutation = { mutate: revokeMutate, isPending: true };
    sharedLinksResult = { data: [link()] };
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const btn = screen.getByRole('button', { name: 'Revoking…' });
    expect(btn).toBeDisabled();
  });
});
