import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { renderWithProviders } from '@/test/utils';

// ---------------------------------------------------------------------------
// Mocks — the modal drives two mutations (MS Project create-project, native
// program-seed import). Control both so we can walk idle → uploading →
// error/success and the two source formats. The child ImportDropzone and
// FormatPicker are the real components (tested elsewhere) — we interact via
// their public roles.
// ---------------------------------------------------------------------------

const createState = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));
const seedState = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));
// The 202 job poll (ADR-0726). `data` undefined = nothing queued yet.
const statusState = vi.hoisted(() => ({
  data: undefined as { status: string; error_detail: string } | undefined,
}));

vi.mock('@/hooks/useMsProjectImportExport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/hooks/useMsProjectImportExport')>();
  return { ...actual, useCreateProjectFromImport: () => createState };
});

vi.mock('@/hooks/useProgramSeedIo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useProgramSeedIo')>();
  return {
    ...actual,
    useImportProgramSeed: () => seedState,
    useProgramImportStatus: () => statusState,
  };
});

const { ImportProjectModal } = await import('./ImportProjectModal');

function resetState() {
  Object.assign(createState, {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
  Object.assign(seedState, {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
  statusState.data = undefined;
}

/** The 202 envelope the seed mutation now resolves with (ADR-0726 §6). */
function queued(programId = 'prog-77') {
  return {
    queued: true,
    program_id: programId,
    import_request_id: 'job-1',
    replaced_program_id: null,
  };
}

/** A 409 replace refusal, the shape `seedReplaceConflict` reads (#2581). */
function conflictErr(code = 'seed_replace_required'): AxiosError {
  const err = new AxiosError('conflict');
  err.response = {
    data: {
      detail: 'A program you own already uses the code "atlas".',
      code,
      conflict: {
        program_id: 'prog-live',
        name: 'Atlas Platform Launch',
        code: 'atlas',
        project_count: 3,
        task_count: 812,
      },
    },
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function axiosErr(detail: unknown): AxiosError {
  const err = new AxiosError('bad request');
  err.response = {
    data: { detail },
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function xmlFile(name = 'plan.xml') {
  return new File(['<Project/>'], name, { type: 'text/xml' });
}
function jsonFile(name = 'seed.json') {
  return new File(['{}'], name, { type: 'application/json' });
}
/** Wrong extension for both formats — always rejected by the dropzone. */
function mppFile(name = 'legacy.mpp') {
  return new File(['bin'], name, { type: 'application/octet-stream' });
}

function pickFile(file: File) {
  // The real ImportDropzone hides a native <input type=file>; drive it directly.
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

function setup(props: Partial<ComponentProps<typeof ImportProjectModal>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onProgramImported = vi.fn();
  renderWithProviders(
    <ImportProjectModal
      onClose={onClose}
      onCreated={onCreated}
      onProgramImported={onProgramImported}
      {...props}
    />,
  );
  return { onClose, onCreated, onProgramImported };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

describe('ImportProjectModal — idle / standalone entry', () => {
  it('renders the MS Project subtitle by default and traps focus on the dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Import a project' });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByText(/Upload a Microsoft Project file to create a new project/),
    ).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps Import disabled until a file is chosen', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('offers the native TruePPM tile as a live choice in the standalone entry', () => {
    setup();
    const truePpm = screen.getByRole('radio', { name: /TruePPM/ });
    expect(truePpm).not.toHaveAttribute('aria-disabled');
  });
});

describe('ImportProjectModal — scoped to an existing program', () => {
  it('disables the native TruePPM tile and shows the "added to program" hint after a pick', () => {
    setup({ programId: 'prog-1', programName: 'Apollo' });
    // Native seed cannot nest in a program → tile is disabled here.
    const truePpm = screen.getByRole('radio', { name: /TruePPM/ });
    expect(truePpm).toHaveAttribute('aria-disabled');
    // Choose an MS Project file and the program affordance appears.
    pickFile(xmlFile());
    expect(screen.getByText(/Will be added to the/)).toHaveTextContent('Apollo');
  });
});

describe('ImportProjectModal — MS Project happy path', () => {
  it('submits the picked file to the create mutation and forwards the new id on success', async () => {
    createState.mutate = vi.fn(
      (_vars: unknown, opts: { onSuccess: (data: { project_id: string }) => void }) =>
        opts.onSuccess({ project_id: 'proj-99' }),
    );
    const { onCreated } = setup({ programId: 'prog-1' });
    pickFile(xmlFile('roadmap.xml'));
    const importBtn = screen.getByRole('button', { name: 'Import' });
    expect(importBtn).toBeEnabled();
    await userEvent.click(importBtn);
    expect(createState.mutate).toHaveBeenCalledTimes(1);
    // programId is threaded into the mutation payload.
    expect(createState.mutate.mock.calls[0][0]).toMatchObject({ programId: 'prog-1' });
    expect(onCreated).toHaveBeenCalledWith('proj-99');
  });

  it('does not submit when no file is selected (Import stays a no-op)', () => {
    setup();
    // Import is disabled; a forced click still does nothing.
    const importBtn = screen.getByRole('button', { name: 'Import' });
    expect(importBtn).toBeDisabled();
    expect(createState.mutate).not.toHaveBeenCalled();
  });
});

describe('ImportProjectModal — uploading state', () => {
  it('shows the progress bar with the file name while pending', () => {
    createState.isPending = true;
    setup();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Uploading');
    expect(screen.getByRole('progressbar', { name: 'Uploading file' })).toBeInTheDocument();
    // The idle FormatPicker/dropzone are gone while uploading.
    expect(screen.queryByRole('radiogroup', { name: 'Import format' })).not.toBeInTheDocument();
  });
});

describe('ImportProjectModal — MS Project error state', () => {
  it('renders the server detail message for a single-message failure', () => {
    createState.isError = true;
    createState.error = axiosErr('This XML is missing a <Tasks> element.');
    setup();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This XML is missing a <Tasks> element.');
    expect(screen.getByRole('button', { name: 'Try a different file' })).toBeInTheDocument();
  });

  it('falls back to a generic message when the error has no server detail', () => {
    createState.isError = true;
    createState.error = new Error('network');
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn't read this file/,
    );
  });

  it('"Try a different file" clears the file and resets the mutation', async () => {
    createState.isError = true;
    createState.error = axiosErr('nope');
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Try a different file' }));
    expect(createState.reset).toHaveBeenCalled();
    expect(seedState.reset).toHaveBeenCalled();
  });

  it('Close in the error state calls onClose', async () => {
    createState.isError = true;
    createState.error = axiosErr('nope');
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ImportProjectModal — native TruePPM seed path', () => {
  async function switchToTruePpm() {
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));
  }

  it('switches the subtitle and accepted format when TruePPM is selected', async () => {
    setup();
    await switchToTruePpm();
    expect(
      screen.getByText(/Upload a TruePPM export \(\.json\) to recreate its program/),
    ).toBeInTheDocument();
  });

  it('submits a JSON seed to the seed mutation and forwards the program id once the job lands', async () => {
    seedState.mutate = vi.fn(
      (
        _input: unknown,
        opts: { onSuccess: (data: ReturnType<typeof queued>) => void },
      ) => opts.onSuccess(queued()),
    );
    statusState.data = { status: 'success', error_detail: '' };
    const { onProgramImported } = setup();
    await switchToTruePpm();
    pickFile(jsonFile('export.json'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(seedState.mutate).toHaveBeenCalledTimes(1);
    // The mutation variable is now an input object, not a bare File — and an
    // unconfirmed import carries neither consent field.
    expect(Object.keys(seedState.mutate.mock.calls[0][0] as object)).toEqual(['file']);
    expect(onProgramImported).toHaveBeenCalledWith('prog-77');
  });

  it('holds a "building" status while the queued job is still running', async () => {
    seedState.mutate = vi.fn(
      (
        _input: unknown,
        opts: { onSuccess: (data: ReturnType<typeof queued>) => void },
      ) => opts.onSuccess(queued()),
    );
    statusState.data = { status: 'running', error_detail: '' };
    const { onProgramImported } = setup();
    await switchToTruePpm();
    pickFile(jsonFile('export.json'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(screen.getByRole('status')).toHaveTextContent('Building the imported program…');
    expect(onProgramImported).not.toHaveBeenCalled();
  });

  it('surfaces the job error_detail when the background build fails', async () => {
    seedState.mutate = vi.fn(
      (
        _input: unknown,
        opts: { onSuccess: (data: ReturnType<typeof queued>) => void },
      ) => opts.onSuccess(queued()),
    );
    statusState.data = { status: 'failed', error_detail: 'Seed references an unknown resource.' };
    const { onProgramImported } = setup();
    await switchToTruePpm();
    pickFile(jsonFile('export.json'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Seed references an unknown resource.');
    expect(onProgramImported).not.toHaveBeenCalled();
  });

  it('renders a multi-line validation report from the seed importer', async () => {
    seedState.isError = true;
    seedState.error = axiosErr(['Row 3: missing task name', 'Row 8: bad date']);
    setup();
    await switchToTruePpm();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't import this file:");
    expect(alert).toHaveTextContent('Row 3: missing task name');
    expect(alert).toHaveTextContent('Row 8: bad date');
  });

  it('truncates a long validation report to 8 lines with an overflow note', async () => {
    const lines = Array.from({ length: 11 }, (_, i) => `Error line ${i + 1}`);
    seedState.isError = true;
    seedState.error = axiosErr(lines);
    setup();
    await switchToTruePpm();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('…and 3 more.');
    // Line 9 is beyond the 8-item slice and should not render.
    expect(alert).not.toHaveTextContent('Error line 9');
  });

  it('falls back to a generic seed error when the report is empty', async () => {
    seedState.isError = true;
    seedState.error = axiosErr(undefined);
    setup();
    await switchToTruePpm();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Import failed — please check the file and try again.',
    );
  });
});

// ---------------------------------------------------------------------------
// Replace confirmation (#2581, ADR-0726) — the 409 is a question, not an error.
// ---------------------------------------------------------------------------

describe('ImportProjectModal — seed replace confirmation', () => {
  async function importWithConflict(code = 'seed_replace_required') {
    // Only the *unconfirmed* attempt collides; the confirmed retry is accepted,
    // so the dialog must not reappear behind its own confirm.
    seedState.mutate = vi.fn(
      (
        input: { replace?: boolean },
        opts: { onError: (e: unknown) => void; onSuccess: (d: ReturnType<typeof queued>) => void },
      ) => {
        if (input.replace) {
          opts.onSuccess(queued());
          return;
        }
        seedState.isError = true;
        seedState.error = conflictErr(code);
        opts.onError(seedState.error);
      },
    );
    const handles = setup();
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));
    pickFile(jsonFile('atlas.json'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    return handles;
  }

  it('names the program, its counts, and what survives — instead of an error dump', async () => {
    await importWithConflict();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Replace “Atlas Platform Launch”?');
    expect(dialog).toHaveTextContent('3 projects and 812 tasks');
    expect(dialog).toHaveTextContent(
      'Its projects move to Trash and can be restored individually as standalone projects.',
    );
    expect(dialog).toHaveTextContent('The program itself is not recoverable.');
  });

  it('re-submits the same file with replace + the compare-and-swap token on confirm', async () => {
    await importWithConflict();
    await userEvent.click(screen.getByRole('button', { name: 'Replace program' }));

    expect(seedState.mutate).toHaveBeenCalledTimes(2);
    expect(seedState.mutate.mock.calls[1][0]).toMatchObject({
      replace: true,
      expectedProgramId: 'prog-live',
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('treats a stale compare-and-swap token (seed_replace_mismatch) as the same question', async () => {
    await importWithConflict('seed_replace_mismatch');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Replace “Atlas Platform Launch”?');
  });

  it('Cancel returns to the picker rather than repainting the 409 as an error', async () => {
    await importWithConflict();
    // Scoped to the alertdialog — the modal beneath has its own Cancel.
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(seedState.reset).toHaveBeenCalled();
  });
});

describe('ImportProjectModal — format switching clears state', () => {
  it('clears a picked file when the format changes', async () => {
    setup();
    pickFile(xmlFile());
    // The dropzone now shows the selected file with a Remove control.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    // Switch to TruePPM → the file is cleared and both mutations reset.
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(createState.reset).toHaveBeenCalled();
  });
});

describe('ImportProjectModal — dismissal', () => {
  it('Escape closes the dialog', async () => {
    const { onClose } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('the scrim button closes the dialog', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel closes the dialog', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores keys that are neither Escape nor Tab', () => {
    const { onClose } = setup();
    const dialog = screen.getByRole('dialog', { name: 'Import a project' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('restores focus to the element that opened it', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open import';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = renderWithProviders(
      <ImportProjectModal onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// ---------------------------------------------------------------------------
// Focus trap — Tab/Shift+Tab cycle within the dialog. The first focusable is
// the TruePPM format tile; the last is the Import button (once a file makes it
// enabled, so it is not filtered out by the :not([disabled]) selector).
// ---------------------------------------------------------------------------

describe('ImportProjectModal — focus trap', () => {
  function firstFocusable() {
    return screen.getByRole('radio', { name: /TruePPM/ });
  }
  function lastFocusable() {
    return screen.getByRole('button', { name: 'Import' });
  }

  it('wraps Tab from the last control back to the first', () => {
    setup();
    pickFile(xmlFile());
    lastFocusable().focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstFocusable());
  });

  it('wraps Shift+Tab from the first control to the last', () => {
    setup();
    pickFile(xmlFile());
    firstFocusable().focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastFocusable());
  });

  it('leaves Tab alone in the middle of the cycle', () => {
    setup();
    pickFile(xmlFile());
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });

  it('leaves Shift+Tab alone in the middle of the cycle', () => {
    setup();
    pickFile(xmlFile());
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});

// ---------------------------------------------------------------------------
// Rejected files
// ---------------------------------------------------------------------------

describe('ImportProjectModal — rejected files', () => {
  it('surfaces the rejection and auto-opens the .xml guidance for MS Project', () => {
    setup();
    const guidance = screen.getByRole('button', { name: /How do I get an .xml file/ });
    expect(guidance).toHaveAttribute('aria-expanded', 'false');

    pickFile(mppFile());

    expect(screen.getByRole('alert')).toHaveTextContent(/That file can't be imported/);
    expect(guidance).toHaveAttribute('aria-expanded', 'true');
    // Nothing was selected, so Import stays unavailable.
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('surfaces the rejection without any guidance disclosure on the native seed path', async () => {
    setup();
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));
    pickFile(xmlFile());

    expect(screen.getByRole('alert')).toHaveTextContent(/\.json only/);
    expect(
      screen.queryByRole('button', { name: /How do I get an .xml file/ }),
    ).not.toBeInTheDocument();
  });

  it('toggles the guidance disclosure by hand', async () => {
    setup();
    const guidance = screen.getByRole('button', { name: /How do I get an .xml file/ });
    await userEvent.click(guidance);
    expect(guidance).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(guidance);
    expect(guidance).toHaveAttribute('aria-expanded', 'false');
  });

  it('clears the rejection message once a valid file is picked', () => {
    setup();
    pickFile(mppFile());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    pickFile(xmlFile());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Clearing / re-picking
// ---------------------------------------------------------------------------

describe('ImportProjectModal — clearing the picked file', () => {
  it('Remove clears the selection and resets both mutations', async () => {
    setup();
    pickFile(xmlFile());
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(createState.reset).toHaveBeenCalled();
    expect(seedState.reset).toHaveBeenCalled();
  });

  it('re-selecting the format that is already active is a no-op', async () => {
    setup();
    pickFile(xmlFile());
    const resetsAfterPick = createState.reset.mock.calls.length;

    await userEvent.click(screen.getByRole('radio', { name: /Industry-standard schedule/ }));

    // Still the same picked file — no clear, no extra reset.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(createState.reset.mock.calls.length).toBe(resetsAfterPick);
  });
});

// ---------------------------------------------------------------------------
// Error-message normalization edge cases
// ---------------------------------------------------------------------------

describe('ImportProjectModal — error normalization', () => {
  it('falls back to the generic message when the server detail is not a string', () => {
    createState.isError = true;
    createState.error = axiosErr({ code: 42 });
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't read this file/);
  });

  it('renders a single-line seed failure as one message, not a bulleted report', async () => {
    seedState.isError = true;
    seedState.error = axiosErr('A program with that key already exists.');
    setup();
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('A program with that key already exists.');
    expect(alert).not.toHaveTextContent("Couldn't import this file:");
    expect(alert.querySelector('ul')).toBeNull();
  });

  it('shows exactly eight lines and no overflow note for an eight-line report', async () => {
    seedState.isError = true;
    seedState.error = axiosErr(Array.from({ length: 8 }, (_, i) => `Error line ${i + 1}`));
    setup();
    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));

    const alert = screen.getByRole('alert');
    expect(alert.querySelectorAll('li')).toHaveLength(8);
    expect(alert).not.toHaveTextContent('…and');
  });
});

// ---------------------------------------------------------------------------
// Optional props
// ---------------------------------------------------------------------------

describe('ImportProjectModal — optional props', () => {
  it('does not blow up on a seed success when no onProgramImported is wired', async () => {
    seedState.mutate = vi.fn(
      (_file: File, opts: { onSuccess: (data: { id: string }) => void }) =>
        opts.onSuccess({ id: 'prog-1' }),
    );
    const onCreated = vi.fn();
    renderWithProviders(<ImportProjectModal onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.click(screen.getByRole('radio', { name: /TruePPM/ }));
    pickFile(jsonFile());
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(seedState.mutate).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('omits the "added to program" hint when the program name is unknown', () => {
    setup({ programId: 'prog-1' });
    pickFile(xmlFile());
    expect(screen.queryByText(/Will be added to the/)).not.toBeInTheDocument();
  });
});
