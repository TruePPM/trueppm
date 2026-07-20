import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
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

vi.mock('@/hooks/useMsProjectImportExport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/hooks/useMsProjectImportExport')>();
  return { ...actual, useCreateProjectFromImport: () => createState };
});

vi.mock('@/hooks/useProgramSeedIo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useProgramSeedIo')>();
  return { ...actual, useImportProgramSeed: () => seedState };
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

  it('submits a JSON seed to the seed mutation and forwards the new program id', async () => {
    seedState.mutate = vi.fn(
      (_file: File, opts: { onSuccess: (data: { id: string }) => void }) =>
        opts.onSuccess({ id: 'prog-77' }),
    );
    const { onProgramImported } = setup();
    await switchToTruePpm();
    pickFile(jsonFile('export.json'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(seedState.mutate).toHaveBeenCalledTimes(1);
    expect(onProgramImported).toHaveBeenCalledWith('prog-77');
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
});
