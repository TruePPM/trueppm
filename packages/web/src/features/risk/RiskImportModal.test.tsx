/**
 * Tests for <RiskImportModal> (#223) — the risk CSV import dialog. Covers the
 * upload → result state machine: file selection gating the Import button, the
 * partial-success result view (counts + per-row errors/warnings), and the
 * hard-error branch. The dropzone itself is tested separately.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RiskImportModal } from './RiskImportModal';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderModal(onClose = vi.fn()) {
  render(wrapper(<RiskImportModal projectId="p1" onClose={onClose} />));
  return { onClose };
}

function selectFile(name = 'risks.csv') {
  const file = new File(['Title\nServer outage'], name, { type: 'text/csv' });
  const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });
  return file;
}

describe('<RiskImportModal>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables Import until a file is selected', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    selectFile();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('shows the result summary with skipped and warning rows on partial success', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        imported: 2,
        skipped: 1,
        errors: [{ row: 4, field: 'Title', message: 'Title is required.' }],
        warnings: [{ row: 3, field: 'Owner', message: 'No member matches "ghost"; left unassigned.' }],
      },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(screen.getByText(/Imported 2 risks, skipped 1\./)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Row 4 · Title: Title is required\./)).toBeInTheDocument();
    expect(screen.getByText(/Row 3 · Owner:/)).toBeInTheDocument();
    // Result view offers a re-import and a close.
    expect(screen.getByRole('button', { name: 'Import another' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('renders the singular noun and omits "skipped" when nothing was skipped', async () => {
    postMock.mockResolvedValueOnce({
      data: { imported: 1, skipped: 0, errors: [], warnings: [] },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(screen.getByText(/Imported 1 risk\./)).toBeInTheDocument());
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });

  it('surfaces the server detail message on a hard error', async () => {
    postMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { detail: 'File too large (limit 2 MB).' } },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(screen.getByText(/File too large \(limit 2 MB\)\./)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Try a different file' })).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
