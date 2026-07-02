import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceEmailPage } from './WorkspaceEmailPage';
import type { EmailSettingsStatus } from '@/hooks/useEmailSettings';

const useEmailSettings = vi.fn();

vi.mock('@/hooks/useEmailSettings', () => ({
  useEmailSettings: () => useEmailSettings() as unknown,
}));

const DATA: EmailSettingsStatus = {
  transport: 'smtp',
  host: 'mail.truescope.io',
  host_configured: true,
  port: 587,
  use_tls: true,
  use_ssl: false,
  from_email: 'notify@truescope.io',
  configured_via: 'environment',
};

beforeEach(() => {
  useEmailSettings.mockReset();
});

describe('WorkspaceEmailPage', () => {
  it('shows a loading state', () => {
    useEmailSettings.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(<WorkspaceEmailPage />);
    expect(screen.getByLabelText('Loading email settings')).toBeInTheDocument();
  });

  it('renders the transport + from identity read-only', () => {
    useEmailSettings.mockReturnValue({ data: DATA, isLoading: false, isError: false, refetch: vi.fn() });
    render(<WorkspaceEmailPage />);
    expect(screen.getByRole('heading', { name: 'Email & SMTP' })).toBeInTheDocument();
    expect(screen.getByText('mail.truescope.io')).toBeInTheDocument();
    expect(screen.getByText('notify@truescope.io')).toBeInTheDocument();
    expect(screen.getByText(/587/)).toBeInTheDocument();
    expect(
      screen.getByText(/environment variables \/ Helm values and redeploy/i),
    ).toBeInTheDocument();
  });

  it('shows "Not configured" when no host is set', () => {
    useEmailSettings.mockReturnValue({
      data: { ...DATA, host: '', host_configured: false },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('shows an error + retry', () => {
    const refetch = vi.fn();
    useEmailSettings.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Couldn.t load email settings/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });
});
