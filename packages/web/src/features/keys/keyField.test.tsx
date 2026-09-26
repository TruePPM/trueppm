import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { KeyStatusLine } from './KeyStatusLine';
import { KeySettingsRow } from './KeySettingsRow';
import { useCreateKeyField } from './useCreateKeyField';
import { keyFormatError, normalizeKeyInput } from './keyFormat';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

type Params = { kind: string; name?: string; key?: string; object_id?: string };

/** Answer `/keys/` like the server: a name derives initials; `taken` is a set. */
function serveKeys({ taken = [] as string[], reserved = [] as string[], delayMs = 0 } = {}) {
  getMock.mockImplementation((_url: string, config: { params: Params }) => {
    const { name, key } = config.params;
    let data: Record<string, unknown>;
    if (key !== undefined) {
      if (reserved.includes(key))
        data = { available: false, reason: 'reserved', suggestion: `${key}2` };
      else if (taken.includes(key))
        data = { available: false, reason: 'taken', suggestion: `${key}2` };
      else data = { available: true, reason: null, suggestion: key };
    } else {
      const initials = (name ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase())
        .join('');
      data = { suggestion: initials };
    }
    return new Promise((resolve) => setTimeout(() => resolve({ data }), delayMs));
  });
}

function keyChecks() {
  return getMock.mock.calls.filter(
    ([, cfg]) => (cfg as { params: Params }).params.key !== undefined,
  );
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function CreateHarness({ serverError }: { serverError?: string }) {
  const [name, setName] = useState('');
  const field = useCreateKeyField('project', name);
  return (
    <div>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="Key" value={field.value} onChange={(e) => field.onInput(e.target.value)} />
      <KeyStatusLine id="status" status={field.status} onUseSuggestion={field.applySuggestion} />
      <span data-testid="blocks">{String(field.blocksSubmit)}</span>
      <button type="button" onClick={() => field.setServerError(serverError ?? null)}>
        reject
      </button>
    </div>
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('key format (client-side)', () => {
  it('accepts new-format keys and rejects hyphens, a leading digit, and the length bounds', () => {
    expect(keyFormatError('project', 'PLAT')).toBeNull();
    expect(keyFormatError('project', 'PLAT2')).toBeNull();
    expect(keyFormatError('project', 'ENG-2026')).toMatch(/Letters and digits only/);
    expect(keyFormatError('project', '2PLAT')).toMatch(/Letters and digits only/);
    expect(keyFormatError('project', 'P')).toMatch(/Letters and digits only/);
    expect(keyFormatError('project', 'ABCDEFGHIJK')).toMatch(/Letters and digits only/);
    expect(keyFormatError('program', 'atlas-platform-launch')).toBeNull();
    expect(keyFormatError('program', 'atlas-')).toMatch(/Lowercase letters/);
    expect(keyFormatError('program', 'a'.repeat(41))).toMatch(/Lowercase letters/);
    // Blank means "let the server derive it" — never a format error.
    expect(keyFormatError('project', '')).toBeNull();
  });

  it('cases input the way the server stores it', () => {
    expect(normalizeKeyInput('project', 'pl at')).toBe('PLAT');
    expect(normalizeKeyInput('program', 'Atlas-Launch')).toBe('atlas-launch');
  });
});

describe('useCreateKeyField', () => {
  it('follows Name with the server suggestion while untouched, and reads Available', async () => {
    serveKeys();
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Platform Migration' } });
    await waitFor(() => expect(screen.getByLabelText('Key')).toHaveValue('PM'));
    expect(screen.getByRole('status')).toHaveTextContent('Available');
    // The suggestion is free by construction — no availability check is spent on it.
    expect(keyChecks()).toHaveLength(0);
  });

  it('suggests nothing for an empty Name', async () => {
    serveKeys();
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Platform' } });
    await waitFor(() => expect(screen.getByLabelText('Key')).toHaveValue('P'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    expect(screen.getByLabelText('Key')).toHaveValue('');
  });

  it('stops following Name after the first keystroke, and resumes when cleared', async () => {
    serveKeys();
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Platform Migration' } });
    await waitFor(() => expect(screen.getByLabelText('Key')).toHaveValue('PM'));

    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'plat' } });
    expect(screen.getByLabelText('Key')).toHaveValue('PLAT');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Something Else Now' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByLabelText('Key')).toHaveValue('PLAT');

    fireEvent.change(screen.getByLabelText('Key'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByLabelText('Key')).toHaveValue('SEN'));
  });

  it('checks a typed key, offers the suggestion when taken, and blocks submit', async () => {
    serveKeys({ taken: ['PLAT'] });
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'PLAT' } });
    const tryButton = await screen.findByRole('button', { name: 'Use PLAT2' });
    expect(screen.getByRole('status')).toHaveTextContent('Already in use — try PLAT2');
    expect(screen.getByTestId('blocks')).toHaveTextContent('true');
    expect(keyChecks()[0]?.[1]).toEqual({ params: { kind: 'project', key: 'PLAT' } });

    fireEvent.click(tryButton);
    expect(screen.getByLabelText('Key')).toHaveValue('PLAT2');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Available'));
    expect(screen.getByTestId('blocks')).toHaveTextContent('false');
  });

  it('shows a format error instantly and never asks the server about it', async () => {
    serveKeys();
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: '9' } });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Letters and digits only, starting with a letter, 2–10 characters',
    );
    expect(screen.getByTestId('blocks')).toHaveTextContent('true');
    await new Promise((r) => setTimeout(r, 400));
    expect(keyChecks()).toHaveLength(0);
  });

  it('says a reserved word is reserved without blocking submit', async () => {
    serveKeys({ reserved: ['NEW'] });
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'new' } });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('That word is reserved'),
    );
    expect(screen.getByTestId('blocks')).toHaveTextContent('false');
  });

  it('shows Checking… only when the check itself runs past 300 ms', async () => {
    serveKeys({ delayMs: 800 });
    wrap(<CreateHarness />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'SLOW' } });
    // Debouncing: nothing yet, and never a spinner.
    expect(screen.getByRole('status')).toHaveTextContent('');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checking…'), {
      timeout: 1500,
    });
    // A pending check does not block submit — the server re-validates.
    expect(screen.getByTestId('blocks')).toHaveTextContent('false');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Available'), {
      timeout: 2000,
    });
  });

  it('shows a server rejection verbatim until the key is edited', () => {
    serveKeys();
    wrap(<CreateHarness serverError="This key is already in use." />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'PLAT' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'reject' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('This key is already in use.');
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'PLAT3' } });
    expect(screen.getByRole('status')).not.toHaveTextContent('This key is already in use.');
  });
});

function SettingsHarness(props: {
  saved: string;
  retired?: number;
  canEdit?: boolean;
  kind?: 'project' | 'program';
}) {
  const [value, setValue] = useState(props.saved);
  return (
    <KeySettingsRow
      kind={props.kind ?? 'project'}
      objectId="6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33"
      value={value}
      onChange={setValue}
      savedKey={props.saved}
      retiredKeyCount={props.retired ?? 0}
      canEdit={props.canEdit ?? true}
      serverError={null}
    />
  );
}

describe('KeySettingsRow', () => {
  it('says nothing and checks nothing while the key is unchanged', async () => {
    serveKeys();
    wrap(<SettingsHarness saved="PLAT" />);
    expect(screen.getByRole('textbox', { name: 'Project key' })).toHaveValue('PLAT');
    expect(screen.queryByText(/Old links using/)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(keyChecks()).toHaveLength(0);
  });

  it('checks a changed key against this object and explains that old links keep working', async () => {
    serveKeys();
    wrap(<SettingsHarness saved="PLAT" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project key' }), {
      target: { value: 'core' },
    });
    expect(screen.getByRole('textbox', { name: 'Project key' })).toHaveValue('CORE');
    expect(screen.getByText(/Old links using/)).toHaveTextContent(
      'Old links using PLAT will keep working and open this project. PLAT can’t be used by another project.',
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Available'));
    expect(keyChecks()[0]?.[1]).toEqual({
      params: {
        kind: 'project',
        key: 'CORE',
        object_id: '6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33',
      },
    });
  });

  it('goes read-only at the rename cap and says why', () => {
    serveKeys();
    wrap(<SettingsHarness saved="PLAT" retired={10} />);
    expect(screen.getByRole('textbox', { name: 'Project key' })).toHaveAttribute('readonly');
    expect(
      screen.getByText(
        'This key has been changed 10 times, the most allowed. Contact your workspace admin',
      ),
    ).toBeInTheDocument();
  });

  it('renders plain text and a copy-link button for a read-only caller', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(<SettingsHarness saved="atlas-launch" kind="program" canEdit={false} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('atlas-launch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy program link' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/programs/atlas-launch`),
    );
  });
});
