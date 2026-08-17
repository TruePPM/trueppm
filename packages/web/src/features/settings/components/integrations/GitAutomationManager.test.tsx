import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitAutomationManager } from './GitAutomationManager';
import type { GitAutomationConfig, RotatedGitSecret } from '@/hooks/useGitAutomation';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';

const useCurrentUserRole = vi.fn();
const useGitAutomationConfig = vi.fn();
const updateMutate = vi.fn();
const rotateMutate = vi.fn();

/** Mutable mutation state so tests can drive the pending / error branches. */
const updateState = vi.hoisted(() => ({ isPending: false, isError: false }));
const rotateState = vi.hoisted(() => ({ isPending: false }));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as unknown,
}));

vi.mock('@/hooks/useGitAutomation', () => ({
  useGitAutomationConfig: () => useGitAutomationConfig() as unknown,
  useUpdateGitAutomation: () => ({
    mutate: updateMutate,
    isPending: updateState.isPending,
    isError: updateState.isError,
  }),
  useRotateGitAutomationSecret: () => ({
    mutate: rotateMutate,
    isPending: rotateState.isPending,
  }),
}));

const CONFIG: GitAutomationConfig = {
  enabled: false,
  secret_set: false,
  webhook_url: 'https://app.example.com/api/v1/integrations/projects/p-1/git-webhook/',
  configured_by: null,
  secret_set_at: null,
  updated_at: '2026-06-21T00:00:00Z',
};

function admin() {
  useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
}

/** Admin viewer with a loaded config — the state most tests start from. */
function loaded(over: Partial<GitAutomationConfig> = {}) {
  admin();
  useGitAutomationConfig.mockReturnValue({
    data: { ...CONFIG, ...over },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

/** Swap in a stub clipboard; returns the restore fn. */
function withClipboard(write: (text: string) => Promise<void>) {
  const original = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  return () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
  };
}

beforeEach(() => {
  useCurrentUserRole.mockReset();
  useGitAutomationConfig.mockReset();
  updateMutate.mockReset();
  rotateMutate.mockReset();
  updateState.isPending = false;
  updateState.isError = false;
  rotateState.isPending = false;
});

describe('GitAutomationManager', () => {
  it('renders nothing for a non-admin', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    const { container } = render(<GitAutomationManager projectId="p-1" />);
    expect(container).toBeEmptyDOMElement();
    // Config GET must never fire for a below-admin viewer.
    expect(useGitAutomationConfig).not.toHaveBeenCalled();
  });

  it('renders nothing while the role is still loading', () => {
    useCurrentUserRole.mockReturnValue({ role: null, isLoading: true });
    const { container } = render(<GitAutomationManager projectId="p-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading skeleton', () => {
    admin();
    useGitAutomationConfig.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByLabelText(/Loading Git-event automation/i)).toBeInTheDocument();
  });

  it('shows an error + Retry that refetches', () => {
    admin();
    const refetch = vi.fn();
    useGitAutomationConfig.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/Couldn.t load Git-event automation/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('renders the toggle, webhook URL, and a Generate action when no secret is set', () => {
    admin();
    useGitAutomationConfig.mockReturnValue({ data: CONFIG, isLoading: false, isError: false, refetch: vi.fn() });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByRole('switch', { name: 'Enable Git-event automation' })).toBeInTheDocument();
    expect(screen.getByDisplayValue(CONFIG.webhook_url)).toBeInTheDocument();
    expect(screen.getByText(/No secret yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate secret' })).toBeInTheDocument();
    // Provider hints are present.
    expect(screen.getByText(/Pull requests/i)).toBeInTheDocument();
    expect(screen.getByText(/Merge request events/i)).toBeInTheDocument();
  });

  it('shows "Set on …" and a Rotate action when a secret exists', () => {
    admin();
    useGitAutomationConfig.mockReturnValue({
      data: { ...CONFIG, secret_set: true, secret_set_at: '2026-06-10T00:00:00Z' },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/Set on/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
  });

  it('warns when automation is on but no secret is set', () => {
    admin();
    useGitAutomationConfig.mockReturnValue({
      data: { ...CONFIG, enabled: true, secret_set: false },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/no secret is set — the receiver rejects/i)).toBeInTheDocument();
  });

  it('flips the toggle through the update mutation', () => {
    admin();
    useGitAutomationConfig.mockReturnValue({ data: CONFIG, isLoading: false, isError: false, refetch: vi.fn() });
    render(<GitAutomationManager projectId="p-1" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Git-event automation' }));
    expect(updateMutate).toHaveBeenCalledWith({ enabled: true });
  });

  it('reveals the rotated secret exactly once', async () => {
    admin();
    useGitAutomationConfig.mockReturnValue({ data: CONFIG, isLoading: false, isError: false, refetch: vi.fn() });
    rotateMutate.mockImplementation(
      (_v: unknown, opts: { onSuccess: (d: RotatedGitSecret) => void }) => {
        opts.onSuccess({
          secret: 'THE_RAW_WEBHOOK_SECRET',
          webhook_url: CONFIG.webhook_url,
          secret_set_at: '2026-06-21T00:00:00Z',
        });
      },
    );
    render(<GitAutomationManager projectId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate secret' }));
    const dialog = screen.getByRole('dialog', { name: /Generate webhook secret/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    await waitFor(() => {
      expect(screen.getByText(/only time you.ll see this secret/i)).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('THE_RAW_WEBHOOK_SECRET')).toBeInTheDocument();
  });
});

describe('GitAutomationManager — status badge and save feedback', () => {
  it('badges the section Off while automation is disabled', () => {
    loaded();
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  it('badges the section On once automation is enabled', () => {
    loaded({ enabled: true, secret_set: true, secret_set_at: '2026-06-10T00:00:00Z' });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText('On')).toBeInTheDocument();
    // Secret is set, so the "unsecured" warning stays away.
    expect(screen.queryByText(/no secret is set/i)).not.toBeInTheDocument();
  });

  it('surfaces a save failure next to the toggle', () => {
    updateState.isError = true;
    loaded();
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t save — try again\./);
  });

  it('stays quiet while the save succeeds', () => {
    loaded();
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turns automation back off from an enabled toggle', () => {
    loaded({ enabled: true, secret_set: true });
    render(<GitAutomationManager projectId="p-1" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Git-event automation' }));
    expect(updateMutate).toHaveBeenCalledWith({ enabled: false });
  });
});

describe('GitAutomationManager — secret status line', () => {
  it('names the date the secret was set', () => {
    loaded({ secret_set: true, secret_set_at: '2026-06-10T00:00:00Z' });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/^Set on \w+ \d+, 2026\./)).toBeInTheDocument();
  });

  it('falls back to a dateless line when the server omits the timestamp', () => {
    loaded({ secret_set: true, secret_set_at: null });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/^A secret is set\./)).toBeInTheDocument();
  });

  it('echoes an unparseable timestamp verbatim rather than showing "Invalid Date"', () => {
    loaded({ secret_set: true, secret_set_at: 'sometime-last-tuesday' });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByText(/Set on sometime-last-tuesday\./)).toBeInTheDocument();
  });
});

describe('GitAutomationManager — webhook URL copy', () => {
  it('confirms the copy and reverts the label after the confirmation window', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const restore = withClipboard(writeText);
    vi.useFakeTimers();
    try {
      loaded();
      render(<GitAutomationManager projectId="p-1" />);
      const copy = screen.getAllByRole('button', { name: 'Copy' })[0];
      fireEvent.click(copy);
      await act(async () => {
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(CONFIG.webhook_url);
      expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('leaves the label alone when the clipboard is unavailable', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('nope')));
    const restore = withClipboard(writeText);
    try {
      loaded();
      render(<GitAutomationManager projectId="p-1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Copied/ })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('selects the whole URL on focus so it can be copied by hand', () => {
    loaded();
    render(<GitAutomationManager projectId="p-1" />);
    const field = screen.getByLabelText<HTMLInputElement>('Webhook URL');
    const select = vi.spyOn(field, 'select');
    fireEvent.focus(field);
    expect(select).toHaveBeenCalledOnce();
    expect(field.readOnly).toBe(true);
  });
});

describe('GitAutomationManager — rotate/generate modal', () => {
  function openModal(over: Partial<GitAutomationConfig> = {}) {
    loaded(over);
    render(<GitAutomationManager projectId="p-1" />);
    fireEvent.click(
      screen.getByRole('button', { name: over.secret_set ? 'Rotate secret' : 'Generate secret' }),
    );
    return screen.getByRole('dialog');
  }

  it('warns that rotation invalidates the current secret', () => {
    const dialog = openModal({ secret_set: true });
    expect(dialog).toHaveAccessibleName('Generate webhook secret');
    expect(
      within(dialog).getByRole('heading', { name: 'Rotate webhook secret?' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/current secret stops working immediately/i)).toBeVisible();
  });

  it('frames a first-time generation as additive', () => {
    const dialog = openModal();
    expect(
      within(dialog).getByRole('heading', { name: 'Generate webhook secret?' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/You will see it once/i)).toBeVisible();
  });

  it('closes on Cancel without rotating', () => {
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rotateMutate).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    openModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a backdrop press but not on a press inside the panel', () => {
    const dialog = openModal();
    fireEvent.pointerDown(within(dialog).getByRole('heading'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('holds the dialog open against Escape and backdrop while the rotation is in flight', () => {
    rotateState.isPending = true;
    const dialog = openModal();
    expect(within(dialog).getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.pointerDown(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('reports a field error returned by the API', () => {
    rotateMutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) => {
      opts.onError(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { data: { secret: ['Rotated too recently.'] } },
        }),
      );
    });
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('secret: Rotated too recently.');
    // Still on the confirm phase — nothing was revealed.
    expect(screen.queryByText(/only time you.ll see this secret/i)).not.toBeInTheDocument();
  });

  it('reports a scalar error payload', () => {
    rotateMutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) => {
      opts.onError(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { data: { detail: 'Not allowed.' } },
        }),
      );
    });
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('detail: Not allowed.');
  });

  it('falls back to a generic message for an empty error body', () => {
    rotateMutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) => {
      opts.onError(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { data: {} },
        }),
      );
    });
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('falls back to a generic message for a non-HTTP failure', () => {
    rotateMutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) => {
      opts.onError(new Error('Network down'));
    });
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });
});

describe('GitAutomationManager — one-time reveal panel', () => {
  function reveal() {
    loaded();
    rotateMutate.mockImplementation(
      (_v: unknown, opts: { onSuccess: (d: RotatedGitSecret) => void }) => {
        opts.onSuccess({
          secret: 'THE_RAW_WEBHOOK_SECRET',
          webhook_url: CONFIG.webhook_url,
          secret_set_at: '2026-06-21T00:00:00Z',
        });
      },
    );
    render(<GitAutomationManager projectId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate secret' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate secret' }));
    return screen.getByRole('dialog', { name: 'Secret generated' });
  }

  it('copies the revealed secret and confirms it', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const restore = withClipboard(writeText);
    try {
      const dialog = reveal();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: /Copied/ })).toBeInTheDocument();
      });
      expect(writeText).toHaveBeenCalledWith('THE_RAW_WEBHOOK_SECRET');
    } finally {
      restore();
    }
  });

  it('keeps the secret selectable when the clipboard rejects', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('no')));
    const restore = withClipboard(writeText);
    try {
      const dialog = reveal();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      const field = within(dialog).getByLabelText<HTMLInputElement>('New webhook secret');
      const select = vi.spyOn(field, 'select');
      fireEvent.focus(field);
      expect(select).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it('dismisses the reveal with Done, making the secret unrecoverable', () => {
    const dialog = reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('THE_RAW_WEBHOOK_SECRET')).not.toBeInTheDocument();
  });
});

describe('GitAutomationManager — last delivery (#2882)', () => {
  it('states plainly that nothing has arrived yet, and names the prerequisite', () => {
    // The honest empty state. Rendering a neutral "Last delivery: —" here would read
    // as "no problems", which the server has made no claim about.
    loaded({ enabled: true, secret_set: true });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByTestId('git-last-delivery-empty')).toHaveTextContent(
      /No webhook delivery received yet/i,
    );
    expect(screen.getByTestId('git-last-delivery-empty')).toHaveTextContent(/External links/i);
    expect(screen.queryByTestId('git-last-delivery')).not.toBeInTheDocument();
  });

  it('surfaces the unmatched-delivery failure that used to be invisible', () => {
    // no_link is the defining silent failure: the provider shows a green check, the
    // API returns 200, and no card moves. This row is the only place it surfaces.
    loaded({
      enabled: true,
      secret_set: true,
      last_delivery_at: '2026-08-17T09:30:00Z',
      last_delivery_outcome: 'no_link',
      last_delivery_provider: 'github',
    });
    render(<GitAutomationManager projectId="p-1" />);
    const row = screen.getByTestId('git-last-delivery');
    expect(row).toHaveTextContent(/No task is linked to that pull\/merge request/i);
    expect(row).toHaveTextContent(/github/);
    // The actionable next step, not just the diagnosis.
    expect(row).toHaveTextContent(/Files → External links/i);
  });

  it('surfaces a rejected signature, which the caller only ever saw as a 404', () => {
    loaded({
      enabled: true,
      secret_set: true,
      last_delivery_at: '2026-08-17T09:30:00Z',
      last_delivery_outcome: 'bad_signature',
      last_delivery_provider: 'gitlab',
    });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByTestId('git-last-delivery')).toHaveTextContent(/Signature rejected/i);
    expect(screen.getByTestId('git-last-delivery')).toHaveTextContent(/Rotate the secret/i);
  });

  it('explains a draft as deliberate rather than broken', () => {
    loaded({
      enabled: true,
      secret_set: true,
      last_delivery_at: '2026-08-17T09:30:00Z',
      last_delivery_outcome: 'draft',
      last_delivery_provider: 'github',
    });
    render(<GitAutomationManager projectId="p-1" />);
    const row = screen.getByTestId('git-last-delivery');
    expect(row).toHaveTextContent(/Draft pull\/merge request ignored/i);
    expect(row).toHaveTextContent(/Mark it ready for review/i);
  });

  it('confirms a successful move', () => {
    loaded({
      enabled: true,
      secret_set: true,
      last_delivery_at: '2026-08-17T09:30:00Z',
      last_delivery_outcome: 'opened_review',
      last_delivery_provider: 'github',
    });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByTestId('git-last-delivery')).toHaveTextContent(/Card moved to Review/i);
  });

  it('renders an outcome token it has never seen instead of blanking the row', () => {
    // The server owns this vocabulary and will grow it. An unknown token must
    // degrade to itself — a silent empty row would be the original bug again.
    loaded({
      enabled: true,
      secret_set: true,
      last_delivery_at: '2026-08-17T09:30:00Z',
      last_delivery_outcome: 'some_future_outcome',
      last_delivery_provider: 'github',
    });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByTestId('git-last-delivery')).toHaveTextContent('some_future_outcome');
  });

  it('degrades to the empty state when an older API omits the fields entirely', () => {
    loaded({ enabled: true, secret_set: true });
    render(<GitAutomationManager projectId="p-1" />);
    expect(screen.getByTestId('git-last-delivery-empty')).toBeInTheDocument();
  });
});
