import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceEmailPage } from './WorkspaceEmailPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
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
  frontend_base_url: 'https://app.example.com',
  frontend_base_url_configured: true,
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
  // The dirty-form save contract publishes onSave/onReset into this global
  // store; reset it so a prior test's registration can't leak into the next.
  useSettingsSaveStore.getState().reset();
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

  it('renders the provider picker and From identity for an operator', () => {
    render(<WorkspaceEmailPage />);
    expect(screen.getByRole('heading', { name: 'Email & SMTP' })).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('cloud');
    expect(screen.getByLabelText<HTMLInputElement>('From address').value).toBe(
      'notify@truescope.io',
    );
    // Cloud is the default → the cloud explainer shows and there is no Host field.
    expect(screen.getByText(/No credentials needed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('SMTP host')).not.toBeInTheDocument();
  });

  it('reveals SMTP fields when the Custom provider is selected', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('SMTP host')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('derives the Gmail provider from a saved smtp.gmail.com host and shows the App-Password help', () => {
    mockHooks({ transport_mode: 'smtp', host: 'smtp.gmail.com', port: 587, security: 'tls' });
    render(<WorkspaceEmailPage />);
    // (transport_mode, host) projects back onto the Gmail preset.
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('gmail');
    // The credential is labeled App password and carries the guided FieldHelp.
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gmail App password/i })).toBeInTheDocument();
    // Host/port/security are collapsed behind Advanced (defaults match), with a summary strip.
    const advanced = screen.getByRole('button', { name: /Advanced — server settings/i });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('smtp.gmail.com · 587 · STARTTLS')).toBeInTheDocument();
  });

  it('pre-fills host/port/security when the Gmail preset is picked', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gmail' } });
    expect(screen.getByText('smtp.gmail.com · 587 · STARTTLS')).toBeInTheDocument();
    // Expand Advanced to confirm the fields are editable and pre-filled.
    fireEvent.click(screen.getByRole('button', { name: /Advanced — server settings/i }));
    expect(screen.getByLabelText<HTMLInputElement>('SMTP host').value).toBe('smtp.gmail.com');
  });

  it('shows the plaintext warning when Security is set to None', () => {
    mockHooks({ transport_mode: 'smtp', host: 'mail.internal', security: 'none' });
    render(<WorkspaceEmailPage />);
    // Custom provider (unknown host) → transport fields flat; None → warning callout.
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('custom');
    expect(screen.getByText('Unencrypted connection')).toBeInTheDocument();
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

  it('surfaces the read-only Public URL with a copy button when configured', () => {
    render(<WorkspaceEmailPage />);
    const publicUrl = screen.getByLabelText<HTMLInputElement>('Public URL (read-only)');
    expect(publicUrl.value).toBe('https://app.example.com');
    expect(publicUrl.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByText(/emailed links are broken/i)).not.toBeInTheDocument();
  });

  it('warns that emailed links are broken when the Public URL is unset', () => {
    mockHooks({ frontend_base_url: '', frontend_base_url_configured: false });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Public URL not set/i)).toBeInTheDocument();
    expect(screen.getByText(/won.t open/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Public URL (read-only)')).not.toBeInTheDocument();
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

describe('WorkspaceEmailPage — SES provider', () => {
  it('shows the region select and derives the relay host when SES is picked', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'ses' } });
    const region = screen.getByLabelText<HTMLSelectElement>('SES region');
    expect(region.value).toBe('us-east-1');
    expect(screen.getByText('email-smtp.us-east-1.amazonaws.com · 587 · STARTTLS')).toBeInTheDocument();
    // Credential placeholder switches to the API-key wording.
    expect(screen.getByLabelText<HTMLInputElement>('API key / SMTP password').placeholder).toMatch(
      /Paste API key/i,
    );
  });

  it('recomputes the relay host when the region changes', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'ses' } });
    fireEvent.change(screen.getByLabelText('SES region'), { target: { value: 'eu-west-1' } });
    expect(screen.getByText('email-smtp.eu-west-1.amazonaws.com · 587 · STARTTLS')).toBeInTheDocument();
  });

  it('derives the SES provider and region from a saved SES relay host', () => {
    mockHooks({ transport_mode: 'ses', host: 'email-smtp.ap-southeast-2.amazonaws.com' });
    render(<WorkspaceEmailPage />);
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('ses');
    expect(screen.getByLabelText<HTMLSelectElement>('SES region').value).toBe('ap-southeast-2');
  });
});

describe('WorkspaceEmailPage — SendGrid provider', () => {
  it('shows the SendGrid relay card and API-key credential label', () => {
    mockHooks({ transport_mode: 'sendgrid', host: 'smtp.sendgrid.net' });
    render(<WorkspaceEmailPage />);
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('sendgrid');
    expect(screen.getByText(/smtp\.sendgrid\.net · 587 · STARTTLS/)).toBeInTheDocument();
    expect(screen.getByLabelText('API key / SMTP password')).toBeInTheDocument();
  });
});

describe('WorkspaceEmailPage — credential field', () => {
  it('toggles the password between hidden and visible', () => {
    mockHooks({ transport_mode: 'smtp', host: 'mail.example.com' });
    render(<WorkspaceEmailPage />);
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    expect(pw.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText<HTMLInputElement>('Password').type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByLabelText<HTMLInputElement>('Password').type).toBe('password');
  });

  it('shows the Fastmail App-Password hint when no secret is set', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'fastmail' } });
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
    expect(screen.getByText(/Use an App Password, not your account password/i)).toBeInTheDocument();
  });

  it('auto-expands Advanced when a preset host diverges from its default', () => {
    // Gmail host but a non-default port → prior customization must be visible.
    mockHooks({ transport_mode: 'smtp', host: 'smtp.gmail.com', port: 2525, security: 'tls' });
    render(<WorkspaceEmailPage />);
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('gmail');
    expect(screen.getByRole('button', { name: /Advanced — server settings/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('WorkspaceEmailPage — Security select', () => {
  it('updates the inline hint as the security mode changes', () => {
    mockHooks({ transport_mode: 'smtp', host: 'mail.example.com', security: 'tls' });
    render(<WorkspaceEmailPage />);
    // Security select is present (custom provider renders transport fields flat).
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), {
      target: { value: 'ssl' },
    });
    expect(screen.getByText(/Encrypted from the first byte/i)).toBeInTheDocument();
    // Back to None → the plaintext warning callout appears.
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), {
      target: { value: 'none' },
    });
    expect(screen.getByText('Unencrypted connection')).toBeInTheDocument();
  });
});

describe('WorkspaceEmailPage — save contract', () => {
  it('composes the SES relay host and PUTs the form on save', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'ses' } });
    fireEvent.change(screen.getByLabelText('SES region'), { target: { value: 'eu-central-1' } });
    // Make the form dirty so triggerSave runs this section.
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        transport_mode: 'ses',
        host: 'email-smtp.eu-central-1.amazonaws.com',
      }),
    );
  });

  it('PUTs the edited From name and re-snapshots clean on success', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('From name'), { target: { value: 'Ops Bot' } });
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ from_name: 'Ops Bot' }));
    // Success re-snapshots initial to the saved values → section is clean again.
    await waitFor(() => expect(useSettingsSaveStore.getState().dirty).toBe(false));
  });

  it('surfaces a DRF field error inline and keeps the entered values on save failure', async () => {
    const mutateAsync = vi.fn().mockRejectedValue({
      response: { data: { host: ['Could not connect to that host.'] } },
    });
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    mockHooks({ transport_mode: 'smtp', host: 'mail.example.com' });
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'bad.host' } });
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(await screen.findByText('Transport validation failed')).toBeInTheDocument();
    expect(screen.getByText('Could not connect to that host.')).toBeInTheDocument();
    // The bad value is kept for the operator to correct.
    expect(screen.getByLabelText<HTMLInputElement>('SMTP host').value).toBe('bad.host');
  });

  it('falls back to a generic message for a non-DRF error', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error('network down'));
    mockHooks({ transport_mode: 'smtp', host: 'mail.example.com' });
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'other.host' } });
    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(await screen.findByText(/Could not save the email settings/i)).toBeInTheDocument();
  });

  it('reverts every field and re-derives the provider on discard', async () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('From name'), { target: { value: 'Changed' } });
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    act(() => {
      useSettingsSaveStore.getState().triggerDiscard();
    });

    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('From name').value).toBe('TrueScope'),
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });
});

describe('WorkspaceEmailPage — send test email', () => {
  it('dispatches the test-send mutation when the saved form is clean', () => {
    const mutate = vi.fn();
    useSendTestEmail.mockReturnValue({ mutate, isPending: false, data: undefined });
    render(<WorkspaceEmailPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('disables the test-send button and explains why while the form is dirty', () => {
    render(<WorkspaceEmailPage />);
    fireEvent.change(screen.getByLabelText('From name'), { target: { value: 'Dirty' } });
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
    expect(screen.getByText(/Save your changes first to test the new transport/i)).toBeInTheDocument();
  });

  it('renders the send-test failure result', () => {
    useSendTestEmail.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: { sent: false, error: 'Connection refused' },
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/✗ Connection refused/)).toBeInTheDocument();
  });

  it('shows the pending label while a test send is in flight', () => {
    useSendTestEmail.mockReturnValue({ mutate: vi.fn(), isPending: true, data: undefined });
    render(<WorkspaceEmailPage />);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  });
});

describe('WorkspaceEmailPage — deliverability health', () => {
  it('triggers the health check and renders per-record chips with their statuses', () => {
    const refetch = vi.fn();
    useEmailHealth.mockReturnValue({
      data: { available: true, domain: 'truescope.io', spf: 'pass', dkim: 'warn', dmarc: 'fail' },
      isFetching: false,
      refetch,
    });
    render(<WorkspaceEmailPage />);
    // Button reads "Re-check" once data exists.
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(refetch).toHaveBeenCalled();
    // Each record's word-status renders.
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByText('Warn')).toBeInTheDocument();
    expect(screen.getByText('Fail')).toBeInTheDocument();
  });

  it('shows the unavailable message when the server cannot run checks', () => {
    useEmailHealth.mockReturnValue({
      data: { available: false, domain: '', spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' },
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<WorkspaceEmailPage />);
    expect(screen.getByText(/Deliverability checks are unavailable/i)).toBeInTheDocument();
  });

  it('shows the checking label and disables the button while fetching', () => {
    useEmailHealth.mockReturnValue({ data: undefined, isFetching: true, refetch: vi.fn() });
    render(<WorkspaceEmailPage />);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });
});

describe('WorkspaceEmailPage — field editing', () => {
  it('edits every From-identity and delivery field and PUTs the new values', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('Reply-to address'), {
      target: { value: 'support@truescope.io' },
    });
    fireEvent.change(screen.getByLabelText('DKIM selector'), { target: { value: 'sel1' } });
    fireEvent.change(screen.getByLabelText('Max recipients'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Throttle per minute'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Bounce webhook URL'), {
      target: { value: 'https://hooks.truescope.io/bounce' },
    });

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_to: 'support@truescope.io',
        dkim_selector: 'sel1',
        max_recipients: 25,
        throttle_per_min: 10,
        bounce_webhook_url: 'https://hooks.truescope.io/bounce',
      }),
    );
  });

  it('edits the SES username and the write-only credential', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockHooks({ transport_mode: 'ses', host: 'email-smtp.us-east-1.amazonaws.com' });
    useUpdateEmailSettings.mockReturnValue({ mutateAsync, isPending: false });
    render(<WorkspaceEmailPage />);

    fireEvent.change(screen.getByLabelText('SES SMTP username'), { target: { value: 'AKIA123' } });
    fireEvent.change(screen.getByLabelText('API key / SMTP password'), {
      target: { value: 'secret-key' },
    });

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'AKIA123', password: 'secret-key' }),
    );
  });
});
