import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceEmailPage } from './WorkspaceEmailPage';
import type { EmailSettings } from '@/hooks/useEmailSettings';

const useEmailSettings = vi.fn();
const useUpdateEmailSettings = vi.fn();
const useSendTestEmail = vi.fn();
const useEmailHealth = vi.fn();

vi.mock('@/hooks/useEmailSettings', () => ({
  useEmailSettings: () => useEmailSettings() as unknown,
  useUpdateEmailSettings: () => useUpdateEmailSettings() as unknown,
  useSendTestEmail: () => useSendTestEmail() as unknown,
  useEmailHealth: () => useEmailHealth() as unknown,
}));

const DATA: EmailSettings = {
  transport_mode: 'cloud',
  host: '',
  port: 587,
  security: 'tls',
  username: '',
  password_is_set: false,
  from_name: 'TrueScope',
  from_email: 'notify@truescope.io',
  reply_to: '',
  dkim_selector: '',
  max_recipients: 50,
  throttle_per_min: 0,
  bounce_webhook_url: '',
  can_edit: true,
  configured_via: 'environment',
  host_configured: false,
};

function mockHooks(overrides: Partial<EmailSettings> = {}) {
  useEmailSettings.mockReturnValue({
    data: { ...DATA, ...overrides },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useUpdateEmailSettings.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  useSendTestEmail.mockReturnValue({ mutate: vi.fn(), isPending: false, data: undefined });
  useEmailHealth.mockReturnValue({ data: undefined, isFetching: false, refetch: vi.fn() });
}

beforeEach(() => {
  useEmailSettings.mockReset();
  useUpdateEmailSettings.mockReset();
  useSendTestEmail.mockReset();
  useEmailHealth.mockReset();
  mockHooks();
});

describe('WorkspaceEmailPage (writable)', () => {
  it('shows a loading state', () => {
    useEmailSettings.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByLabelText('Loading email settings')).toBeInTheDocument();
  });

  it('renders the transport picker and From identity for an operator', () => {
    render(<WorkspaceEmailPage />);
    expect(screen.getByRole('heading', { name: 'Email & SMTP' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Custom SMTP/ })).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('From address').value).toBe(
      'notify@truescope.io',
    );
    // Cloud is the default → the cloud explainer shows and there is no Host field.
    expect(screen.getByText(/No credentials needed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('SMTP host')).not.toBeInTheDocument();
  });

  it('reveals SMTP fields when the Custom SMTP transport is selected', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Custom SMTP/ }));
    expect(screen.getByLabelText('SMTP host')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows the write-only "set" placeholder when a secret exists', () => {
    mockHooks({ transport_mode: 'smtp', host: 'mail.x', password_is_set: true });
    render(<WorkspaceEmailPage />);
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    expect(pw.value).toBe('');
    expect(pw.placeholder).toMatch(/leave blank to keep/i);
  });

  it('disables the form and shows a note for a non-operator', () => {
    mockHooks({ can_edit: false });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Only a workspace operator/i)).toBeInTheDocument();
    expect(screen.getByLabelText('From address')).toBeDisabled();
    // The action cards are hidden for a viewer.
    expect(screen.queryByRole('button', { name: 'Send test email' })).not.toBeInTheDocument();
  });

  it('renders the send-test success result', () => {
    useSendTestEmail.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: { sent: true, recipient: 'root@corp.test' },
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Sent — check your inbox/i)).toBeInTheDocument();
  });

  it('shows an error + retry', () => {
    const refetch = vi.fn();
    useEmailSettings.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Couldn.t load email settings/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });
});
