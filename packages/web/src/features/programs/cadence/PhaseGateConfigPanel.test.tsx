/**
 * PhaseGateConfigPanel unit tests (ADR-0079).
 *
 * Covers the four axes the panel branches on:
 *   1. query state — loading skeleton, error alert, and the loaded body
 *   2. permission — `canEdit` (checkbox + footer) vs read-only (ReadOnlyIndicator,
 *      read-only textarea, banner, no footer)
 *   3. dismissal — close button, Cancel, Escape, backdrop, and the in-flight lock
 *      that suppresses all three
 *   4. the failure surface — every `formatMutationError` shape (DRF detail, field
 *      arrays, field strings, unreadable body, non-axios error, blank message)
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { PhaseGateConfig } from '@/api/types';
import type { PhaseGateConfigPatch } from '@/features/programs/hooks/useProgramPhaseGateConfig';
import { PhaseGateConfigPanel } from './PhaseGateConfigPanel';

const getMock = vi.fn<(url: string) => Promise<{ data: PhaseGateConfig }>>();
const patchMock = vi.fn<(url: string, body: PhaseGateConfigPatch) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => getMock(...(args as Parameters<typeof getMock>)),
    patch: (...args: unknown[]) => patchMock(...(args as Parameters<typeof patchMock>)),
  },
}));

const BASE_CONFIG: PhaseGateConfig = {
  id: 'pg1',
  server_version: 1,
  program: 'prog-1',
  enabled: true,
  invite_template: 'Subject: Gate review',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderPanel(overrides: { canEdit?: boolean; onClose?: () => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const view = renderWithProviders(
    <PhaseGateConfigPanel
      programId="prog-1"
      canEdit={overrides.canEdit ?? true}
      onClose={onClose}
    />,
  );
  return { ...view, onClose };
}

/** The backdrop is the dialog's parent — clicking it (target === currentTarget) closes. */
function backdrop(): HTMLElement {
  const parent = screen.getByRole('dialog').parentElement;
  if (!parent) throw new Error('dialog has no backdrop parent');
  return parent;
}

function templateField(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('Invite template');
}

function axiosErrorWith(data: unknown): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data },
  });
}

/** Wait for the query to settle so the form body (not the skeleton) is mounted. */
async function awaitLoaded(): Promise<void> {
  await screen.findByLabelText('Invite template');
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  getMock.mockResolvedValue({ data: BASE_CONFIG });
  patchMock.mockResolvedValue({ data: BASE_CONFIG });
});

describe('PhaseGateConfigPanel — query states', () => {
  it('shows the rule-248 skeleton while the config is loading', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    renderPanel();

    expect(screen.getByRole('status', { name: 'Loading phase gate…' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Invite template')).not.toBeInTheDocument();
    // No footer while loading — there is nothing to save yet.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows a retry alert and no form when the config fails to load', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load template config. Close and retry.',
    );
    expect(screen.queryByLabelText('Invite template')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('hydrates the form from the loaded config', async () => {
    renderPanel();
    await awaitLoaded();

    expect(screen.getByRole('dialog', { name: 'Phase gate calendar' })).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('Enabled')).toBeChecked();
    expect(templateField().value).toBe('Subject: Gate review');
    expect(getMock).toHaveBeenCalledWith('/programs/prog-1/phase-gate-config/');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('claims neither auto-scheduling nor variable substitution (#2896)', async () => {
    // Two claims, one class. The header said the template was "auto-scheduled",
    // and the helper text below the textarea offered "Available variables" —
    // which asserts that something substitutes them. Nothing does: the
    // serializer docstring calls substitution "a downstream calendar-integration
    // follow-up", and invite_template has no readers at all.
    //
    // A vocabulary list is a capability claim, which is why it is asserted here
    // rather than left to the eye — the list looked like documentation and read
    // as a promise. Delete when #2983 ships.
    renderPanel();
    await awaitLoaded();

    expect(screen.getByText(/stored here for you to copy/i)).toBeInTheDocument();
    expect(screen.getByText(/does not replace them/i)).toBeInTheDocument();
    for (const claim of [/auto-scheduled/i, /automatically scheduled/i, /available variables/i]) {
      expect(screen.queryByText(claim)).not.toBeInTheDocument();
    }
  });

  it('leaves the form at its defaults when the config comes back disabled and blank', async () => {
    getMock.mockResolvedValue({
      data: { ...BASE_CONFIG, enabled: false, invite_template: '' },
    });
    renderPanel();
    await awaitLoaded();

    expect(screen.getByLabelText<HTMLInputElement>('Enabled')).not.toBeChecked();
    expect(templateField().value).toBe('');
  });
});

describe('PhaseGateConfigPanel — permission surface', () => {
  it('renders editable controls and the footer for a program admin', async () => {
    renderPanel({ canEdit: true });
    await awaitLoaded();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Enabled')).toBeEnabled();
    expect(templateField()).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('renders the read-only banner, value indicator and no footer below admin', async () => {
    renderPanel({ canEdit: false });
    await awaitLoaded();

    expect(screen.getByRole('status')).toHaveTextContent(
      'Read-only — only program admins can edit this template.',
    );
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'Phase gate: Enabled, managed by a program admin. View only.',
      }),
    ).toBeInTheDocument();
    expect(templateField()).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('reads out "Disabled" in the read-only indicator for a disabled template', async () => {
    getMock.mockResolvedValue({ data: { ...BASE_CONFIG, enabled: false } });
    renderPanel({ canEdit: false });
    await awaitLoaded();

    expect(
      screen.getByRole('img', {
        name: 'Phase gate: Disabled, managed by a program admin. View only.',
      }),
    ).toBeInTheDocument();
  });

  it('keeps the read-only banner but hides the body while the config is loading', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    renderPanel({ canEdit: false });

    const statuses = screen.getAllByRole('status');
    expect(statuses.map((s) => s.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Read-only')]),
    );
    expect(screen.queryByLabelText('Invite template')).not.toBeInTheDocument();
  });
});

describe('PhaseGateConfigPanel — saving', () => {
  it('patches the edited enabled flag and template, then closes', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(screen.getByLabelText('Enabled'));
    fireEvent.change(templateField(), { target: { value: 'Subject: Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(patchMock).toHaveBeenCalledWith('/programs/prog-1/phase-gate-config/', {
      enabled: false,
      invite_template: 'Subject: Updated',
    });
  });

  it('saves on a native form submit as well as the footer button', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    const form = screen.getByRole('dialog').querySelector('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(patchMock).toHaveBeenCalledWith('/programs/prog-1/phase-gate-config/', {
      enabled: true,
      invite_template: 'Subject: Gate review',
    });
  });

  it('locks every control while the save is in flight and blocks dismissal', async () => {
    let settle: (() => void) | undefined;
    patchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => {
            resolve({ data: BASE_CONFIG });
          };
        }),
    );
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByLabelText('Enabled')).toBeDisabled();
    expect(templateField()).toBeDisabled();

    // Neither Escape nor a backdrop click may dismiss a panel mid-save.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();

    settle?.();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('PhaseGateConfigPanel — mutation error surfacing', () => {
  async function saveAndReadError(err: Error): Promise<HTMLElement> {
    patchMock.mockRejectedValueOnce(err);
    const { onClose } = renderPanel();
    await awaitLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(onClose).not.toHaveBeenCalled();
    return alert;
  }

  it('shows a DRF `detail` string verbatim', async () => {
    const alert = await saveAndReadError(axiosErrorWith({ detail: 'Not a program admin.' }));

    expect(alert).toHaveTextContent('Not a program admin.');
  });

  it('joins field-level error arrays into one line', async () => {
    const alert = await saveAndReadError(
      axiosErrorWith({ invite_template: ['Unknown variable.', 'Too long.'] }),
    );

    expect(alert).toHaveTextContent('invite_template: Unknown variable., Too long.');
  });

  it('renders a field whose error is a bare string', async () => {
    const alert = await saveAndReadError(axiosErrorWith({ enabled: 'Must be a boolean.' }));

    expect(alert).toHaveTextContent('enabled: Must be a boolean.');
  });

  it('joins multiple field errors with a period', async () => {
    const alert = await saveAndReadError(
      axiosErrorWith({ enabled: ['Required.'], invite_template: 'Too long.' }),
    );

    expect(alert).toHaveTextContent('enabled: Required.. invite_template: Too long.');
  });

  it('falls back to the error message when the response body has no readable fields', async () => {
    const alert = await saveAndReadError(axiosErrorWith({ status_code: 400 }));

    expect(alert).toHaveTextContent('Request failed with status code 400');
  });

  it('falls back to the error message for an axios error with no response body', async () => {
    const alert = await saveAndReadError(
      Object.assign(new Error('Network Error'), { isAxiosError: true }),
    );

    expect(alert).toHaveTextContent('Network Error');
  });

  it('shows a plain (non-axios) error message', async () => {
    const alert = await saveAndReadError(new Error('Something broke'));

    expect(alert).toHaveTextContent('Something broke');
  });

  it('uses the generic copy when the error carries no message at all', async () => {
    const alert = await saveAndReadError(new Error(''));

    expect(alert).toHaveTextContent('Couldn’t save phase-gate template.');
  });

  it('clears a previous error when the save is retried successfully', async () => {
    patchMock.mockRejectedValueOnce(new Error('Something broke'));
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('PhaseGateConfigPanel — dismissal', () => {
  it('closes on the header close button', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('closes on the Cancel button without saving', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.change(templateField(), { target: { value: 'discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop click', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(backdrop());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the click lands inside the dialog', async () => {
    const { onClose } = renderPanel();
    await awaitLoaded();

    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('heading'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('detaches the Escape listener on unmount', async () => {
    const { onClose, unmount } = renderPanel();
    await awaitLoaded();

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape while the config is loading', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    const { onClose } = renderPanel();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
