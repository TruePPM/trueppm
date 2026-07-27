/**
 * CeremonyModal unit tests (ADR-0079).
 *
 * Covers the three axes the component branches on:
 *   1. initial form state — add mode vs edit mode, and every `makeInitial`
 *      fallback (unparseable monthly day, blank weekday, null time)
 *   2. payload construction per cadence_type (weekly/biweekly, monthly, on_milestone)
 *   3. the failure surface — reserved Scrum names (client-side mirror of the API
 *      rule) and every `formatMutationError` shape (DRF detail, field arrays,
 *      field strings, non-axios errors, blank message)
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { CeremonyTemplate } from '@/api/types';
import type { CeremonyCreatePayload } from '@/features/programs/hooks/useProgramCeremonyMutations';
import { CeremonyModal } from './CeremonyModal';

const postMock = vi.fn<(url: string, body: CeremonyCreatePayload) => Promise<unknown>>();
const patchMock = vi.fn<(url: string, body: CeremonyCreatePayload) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...(args as Parameters<typeof postMock>)),
    patch: (...args: unknown[]) => patchMock(...(args as Parameters<typeof patchMock>)),
  },
}));

const BASE_CEREMONY: CeremonyTemplate = {
  id: 'c1',
  server_version: 1,
  program: 'prog-1',
  name: 'Steering committee',
  cadence_type: 'weekly',
  cadence_day: 'wednesday',
  cadence_time: '09:30:00',
  duration_minutes: 45,
  owner_role: 'Risk Lead',
  enabled: true,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderModal(
  overrides: {
    ceremony?: CeremonyTemplate;
    onClose?: () => void;
    onSaved?: () => void;
  } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onSaved = overrides.onSaved ?? vi.fn();
  const view = renderWithProviders(
    <CeremonyModal
      programId="prog-1"
      ceremony={overrides.ceremony}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { ...view, onClose, onSaved };
}

/** The backdrop is the dialog's parent — clicking it (target === currentTarget) closes. */
function backdrop(): HTMLElement {
  const parent = screen.getByRole('dialog').parentElement;
  if (!parent) throw new Error('dialog has no backdrop parent');
  return parent;
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Name/);
}

function typeName(value: string): void {
  fireEvent.change(nameField(), { target: { value } });
}

/** Submit the form directly — the guard under test disables the submit button. */
function submitForm(): void {
  const form = screen.getByRole('dialog').querySelector('form');
  if (!form) throw new Error('form not found');
  fireEvent.submit(form);
}

function axiosErrorWith(data: unknown): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data },
  });
}

describe('CeremonyModal — initial state', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
  });

  it('opens in add mode with weekly defaults and focuses the name field', () => {
    renderModal();

    expect(screen.getByRole('heading', { name: 'Add ceremony' })).toBeInTheDocument();
    expect(nameField().value).toBe('');
    expect(document.activeElement).toBe(nameField());
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByLabelText<HTMLSelectElement>('Day').value).toBe('monday');
    expect(screen.getByLabelText<HTMLInputElement>('Time').value).toBe('10:00');
    expect(screen.getByLabelText<HTMLSelectElement>('Duration').value).toBe('60');
    expect(screen.getByLabelText<HTMLInputElement>('Owner role').value).toBe('Program Manager');
    expect(screen.getByLabelText(/Enabled when saved/)).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('opens in edit mode with the ceremony hydrated into the form', () => {
    renderModal({ ceremony: BASE_CEREMONY });

    expect(
      screen.getByRole('heading', { name: 'Edit ceremony · Steering committee' }),
    ).toBeInTheDocument();
    expect(nameField().value).toBe('Steering committee');
    expect(screen.getByLabelText<HTMLSelectElement>('Day').value).toBe('wednesday');
    // DRF serializes "HH:MM:SS" — the time input needs "HH:MM".
    expect(screen.getByLabelText<HTMLInputElement>('Time').value).toBe('09:30');
    expect(screen.getByLabelText<HTMLSelectElement>('Duration').value).toBe('45');
    expect(screen.getByLabelText<HTMLInputElement>('Owner role').value).toBe('Risk Lead');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('falls back to monday when an edited weekly ceremony has a blank cadence_day', () => {
    renderModal({ ceremony: { ...BASE_CEREMONY, cadence_day: '' } });

    expect(screen.getByLabelText<HTMLSelectElement>('Day').value).toBe('monday');
  });

  it('falls back to monday for a non-weekday cadence_type that still shows the weekday select', () => {
    // A monthly ceremony keeps `weekday` at the 'monday' default; switching the
    // radio to weekly reveals it.
    renderModal({ ceremony: { ...BASE_CEREMONY, cadence_type: 'monthly', cadence_day: '2nd-friday' } });

    fireEvent.click(screen.getByRole('radio', { name: 'Weekly' }));

    expect(screen.getByLabelText<HTMLSelectElement>('Day').value).toBe('monday');
  });

  it('hydrates the monthly ordinal and weekday from a "2nd-friday" cadence_day', () => {
    renderModal({ ceremony: { ...BASE_CEREMONY, cadence_type: 'monthly', cadence_day: '2nd-friday' } });

    expect(screen.getByLabelText<HTMLSelectElement>('Monthly ordinal').value).toBe('2nd');
    expect(screen.getByLabelText<HTMLSelectElement>('Monthly weekday').value).toBe('friday');
  });

  it('falls back to 1st/thursday when the monthly cadence_day is unparseable', () => {
    renderModal({ ceremony: { ...BASE_CEREMONY, cadence_type: 'monthly', cadence_day: 'garbage' } });

    expect(screen.getByLabelText<HTMLSelectElement>('Monthly ordinal').value).toBe('1st');
    expect(screen.getByLabelText<HTMLSelectElement>('Monthly weekday').value).toBe('thursday');
  });

  it('falls back to 10:00 when the edited ceremony has a null cadence_time', () => {
    renderModal({ ceremony: { ...BASE_CEREMONY, cadence_time: null } });

    expect(screen.getByLabelText<HTMLInputElement>('Time').value).toBe('10:00');
  });

  it('renders an on_milestone ceremony with no day or time, only a duration', () => {
    renderModal({
      ceremony: {
        ...BASE_CEREMONY,
        cadence_type: 'on_milestone',
        cadence_day: '',
        cadence_time: null,
        duration_minutes: 90,
      },
    });

    expect(screen.getByRole('radio', { name: 'On milestone' })).toBeChecked();
    expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Time')).not.toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('Duration').value).toBe('90');
  });

  it('shows the enabled checkbox unchecked for a disabled ceremony', () => {
    renderModal({ ceremony: { ...BASE_CEREMONY, enabled: false } });

    expect(screen.getByLabelText(/Enabled when saved/)).not.toBeChecked();
  });
});

describe('CeremonyModal — cadence type switching', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
  });

  it('swaps the weekday select for the ordinal + weekday pair on monthly', () => {
    renderModal();

    expect(screen.getByLabelText('Day')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Monthly' }));

    expect(screen.getByLabelText('Monthly ordinal')).toBeInTheDocument();
    expect(screen.getByLabelText('Monthly weekday')).toBeInTheDocument();
    // The time column stays — monthly ceremonies still have a start time.
    expect(screen.getByLabelText('Time')).toBeInTheDocument();
  });

  it('hides the day and time columns on on_milestone and restores them on biweekly', () => {
    renderModal();

    fireEvent.click(screen.getByRole('radio', { name: 'On milestone' }));
    expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Time')).not.toBeInTheDocument();
    // The on_milestone duration list is shorter — 15 min is not offered.
    const durationOptions = within(screen.getByLabelText('Duration')).getAllByRole('option');
    expect(durationOptions.map((o) => o.textContent)).not.toContain('15 min');

    fireEvent.click(screen.getByRole('radio', { name: 'Bi-weekly' }));
    expect(screen.getByLabelText('Day')).toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toBeInTheDocument();
  });
});

describe('CeremonyModal — payload construction', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
    postMock.mockResolvedValue({ data: BASE_CEREMONY });
    patchMock.mockResolvedValue({ data: BASE_CEREMONY });
  });

  it('creates a weekly ceremony with the weekday as cadence_day, trimming free text', async () => {
    const { onSaved } = renderModal();

    typeName('  Program sync  ');
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: 'friday' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:15' } });
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Owner role'), { target: { value: '  Sponsor ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/ceremonies/', {
      name: 'Program sync',
      cadence_type: 'weekly',
      cadence_day: 'friday',
      cadence_time: '08:15',
      duration_minutes: 30,
      owner_role: 'Sponsor',
      enabled: true,
    });
  });

  it('joins the ordinal and weekday into cadence_day for a monthly ceremony', async () => {
    const { onSaved } = renderModal();

    typeName('Portfolio review');
    fireEvent.click(screen.getByRole('radio', { name: 'Monthly' }));
    fireEvent.change(screen.getByLabelText('Monthly ordinal'), { target: { value: 'last' } });
    fireEvent.change(screen.getByLabelText('Monthly weekday'), { target: { value: 'tuesday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith(
      '/programs/prog-1/ceremonies/',
      expect.objectContaining({ cadence_type: 'monthly', cadence_day: 'last-tuesday' }),
    );
  });

  it('sends an empty cadence_day and null cadence_time for on_milestone', async () => {
    const { onSaved } = renderModal();

    typeName('Gate review');
    fireEvent.click(screen.getByRole('radio', { name: 'On milestone' }));
    fireEvent.click(screen.getByLabelText(/Enabled when saved/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/ceremonies/', {
      name: 'Gate review',
      cadence_type: 'on_milestone',
      cadence_day: '',
      cadence_time: null,
      duration_minutes: 60,
      owner_role: 'Program Manager',
      enabled: false,
    });
  });

  it('sends the duration chosen from the on_milestone-only duration select', async () => {
    const { onSaved } = renderModal();

    typeName('Gate review');
    fireEvent.click(screen.getByRole('radio', { name: 'On milestone' }));
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith(
      '/programs/prog-1/ceremonies/',
      expect.objectContaining({ cadence_type: 'on_milestone', duration_minutes: 120 }),
    );
  });

  it('patches the existing ceremony (not a create) in edit mode', async () => {
    const { onSaved } = renderModal({ ceremony: BASE_CEREMONY });

    typeName('Steering sync');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).not.toHaveBeenCalled();
    expect(patchMock).toHaveBeenCalledWith(
      '/programs/prog-1/ceremonies/c1/',
      expect.objectContaining({
        name: 'Steering sync',
        cadence_type: 'weekly',
        cadence_day: 'wednesday',
        cadence_time: '09:30',
        duration_minutes: 45,
        owner_role: 'Risk Lead',
      }),
    );
  });

  it('keeps biweekly on the plain weekday form (not the monthly ordinal form)', async () => {
    const { onSaved } = renderModal();

    typeName('Steering');
    fireEvent.click(screen.getByRole('radio', { name: 'Bi-weekly' }));
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: 'thursday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith(
      '/programs/prog-1/ceremonies/',
      expect.objectContaining({ cadence_type: 'biweekly', cadence_day: 'thursday' }),
    );
  });
});

describe('CeremonyModal — name validation (reserved Scrum vocabulary)', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
    postMock.mockResolvedValue({ data: BASE_CEREMONY });
  });

  it('blocks a reserved Scrum name with an inline explanation', () => {
    renderModal();

    typeName('Retrospective');

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent(/Sprint events are configured per-sprint/);
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    expect(nameField()).toHaveAttribute('aria-describedby', 'ceremony-name-error');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('matches reserved names case- and whitespace-insensitively', () => {
    renderModal();

    typeName('  DAILY Standup  ');

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not call the API when the form is submitted with a reserved name', () => {
    renderModal();

    typeName('Sprint planning');
    submitForm();

    expect(postMock).not.toHaveBeenCalled();
  });

  it('does not call the API when the form is submitted with a whitespace-only name', () => {
    renderModal();

    typeName('    ');
    submitForm();

    expect(postMock).not.toHaveBeenCalled();
    // Blank is invalid but not *reserved* — no inline error, no aria-invalid.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(nameField()).not.toHaveAttribute('aria-invalid');
    expect(nameField()).not.toHaveAttribute('aria-describedby');
  });

  it('clears the reserved-name error once the name is edited to a valid one', () => {
    renderModal();

    typeName('Retro');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    typeName('Retro cadence check-in');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('CeremonyModal — mutation error surfacing', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
  });

  async function submitAndReadError(err: Error): Promise<HTMLElement> {
    postMock.mockRejectedValueOnce(err);
    const { onSaved } = renderModal();
    typeName('Program sync');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
    return alert;
  }

  it('shows a DRF `detail` string verbatim', async () => {
    const alert = await submitAndReadError(axiosErrorWith({ detail: 'Not allowed on this program.' }));

    expect(alert).toHaveTextContent('Not allowed on this program.');
  });

  it('joins field-level error arrays into one line', async () => {
    const alert = await submitAndReadError(
      axiosErrorWith({ name: ['This field must be unique.', 'Too long.'] }),
    );

    expect(alert).toHaveTextContent('name: This field must be unique., Too long.');
  });

  it('renders a field whose error is a bare string', async () => {
    const alert = await submitAndReadError(axiosErrorWith({ cadence_time: 'Enter a valid time.' }));

    expect(alert).toHaveTextContent('cadence_time: Enter a valid time.');
  });

  it('joins multiple field errors with a period', async () => {
    const alert = await submitAndReadError(
      axiosErrorWith({ name: ['Required.'], owner_role: 'Too long.' }),
    );

    expect(alert).toHaveTextContent('name: Required.. owner_role: Too long.');
  });

  it('falls back to the error message when the response body has no readable fields', async () => {
    // Neither an array nor a string value → no messages collected.
    const alert = await submitAndReadError(axiosErrorWith({ status_code: 400 }));

    expect(alert).toHaveTextContent('Request failed with status code 400');
  });

  it('falls back to the error message for an axios error with no response body', async () => {
    const alert = await submitAndReadError(
      Object.assign(new Error('Network Error'), { isAxiosError: true }),
    );

    expect(alert).toHaveTextContent('Network Error');
  });

  it('shows a plain (non-axios) error message', async () => {
    const alert = await submitAndReadError(new Error('Something broke'));

    expect(alert).toHaveTextContent('Something broke');
  });

  it('uses the generic copy when the error carries no message at all', async () => {
    const alert = await submitAndReadError(new Error(''));

    expect(alert).toHaveTextContent('Couldn’t save ceremony.');
  });

  it('clears a previous error when the form is resubmitted successfully', async () => {
    postMock.mockRejectedValueOnce(new Error('Something broke'));
    postMock.mockResolvedValueOnce({ data: BASE_CEREMONY });
    const { onSaved } = renderModal();

    typeName('Program sync');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces an edit-mode failure from the patch call', async () => {
    patchMock.mockRejectedValueOnce(axiosErrorWith({ detail: 'Ceremony is locked.' }));
    renderModal({ ceremony: BASE_CEREMONY });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ceremony is locked.');
  });
});

describe('CeremonyModal — dismissal', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
    postMock.mockResolvedValue({ data: BASE_CEREMONY });
  });

  it('closes on the Cancel button', () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop click', () => {
    const { onClose } = renderModal();

    fireEvent.click(backdrop());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the click lands inside the dialog', () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('detaches the Escape listener on unmount', () => {
    const { onClose, unmount } = renderModal();

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CeremonyModal — in-flight save', () => {
  beforeEach(() => {
    postMock.mockReset();
    patchMock.mockReset();
  });

  it('locks the modal while the save is in flight and releases it on completion', async () => {
    let settle: (() => void) | undefined;
    postMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => {
            resolve({ data: BASE_CEREMONY });
          };
        }),
    );
    const { onClose, onSaved } = renderModal();

    typeName('Program sync');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // While pending, neither Escape nor a backdrop click may dismiss the modal.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();

    settle?.();
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });
});
