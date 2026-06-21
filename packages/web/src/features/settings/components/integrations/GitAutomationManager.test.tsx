import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitAutomationManager } from './GitAutomationManager';
import type { GitAutomationConfig, RotatedGitSecret } from '@/hooks/useGitAutomation';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';

const useCurrentUserRole = vi.fn();
const useGitAutomationConfig = vi.fn();
const updateMutate = vi.fn();
const rotateMutate = vi.fn();

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as unknown,
}));

vi.mock('@/hooks/useGitAutomation', () => ({
  useGitAutomationConfig: () => useGitAutomationConfig() as unknown,
  useUpdateGitAutomation: () => ({ mutate: updateMutate, isPending: false, isError: false }),
  useRotateGitAutomationSecret: () => ({ mutate: rotateMutate, isPending: false }),
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

beforeEach(() => {
  useCurrentUserRole.mockReset();
  useGitAutomationConfig.mockReset();
  updateMutate.mockReset();
  rotateMutate.mockReset();
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
