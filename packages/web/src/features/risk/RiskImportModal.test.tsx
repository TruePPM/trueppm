/**
 * Tests for <RiskImportModal> (#223) — the risk CSV import dialog. Covers the
 * upload → result state machine: file selection gating the Import button, the
 * partial-success result view (counts + per-row errors/warnings), the pending
 * view, and the hard-error branch (server `detail` vs the generic fallback).
 * Also covers the modal contract itself — backdrop dismissal, Escape, the
 * Tab/Shift+Tab focus cycle, and focus restoration to the trigger on unmount.
 * The dropzone itself is tested separately.
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { RiskImportModal } from './RiskImportModal';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function renderModal(onClose = vi.fn()) {
  const view = renderWithProviders(<RiskImportModal projectId="p1" onClose={onClose} />);
  return { onClose, ...view };
}

function selectFile(name = 'risks.csv') {
  const file = new File(['Title\nServer outage'], name, { type: 'text/csv' });
  const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });
  return file;
}

/** The dialog's focusable ring, in DOM order, for the Tab-trap assertions. */
function focusRing(container: HTMLElement) {
  const dropzone = screen.getByRole('button', { name: /Choose file or drag one here/ });
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  if (!fileInput) throw new Error('expected the dropzone to render a file input');
  return { first: dropzone, middle: fileInput, last: cancel };
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
        warnings: [
          { row: 3, field: 'Owner', message: 'No member matches "ghost"; left unassigned.' },
        ],
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

  it('omits both issue lists entirely on a clean import', async () => {
    postMock.mockResolvedValueOnce({
      data: { imported: 3, skipped: 0, errors: [], warnings: [] },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(screen.getByText(/Imported 3 risks\./)).toBeInTheDocument());
    expect(screen.queryByText('Skipped rows')).not.toBeInTheDocument();
    expect(screen.queryByText('Warnings')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders a warnings-only import without a skipped-rows list', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        imported: 2,
        skipped: 0,
        errors: [],
        warnings: [{ row: 2, field: 'Probability', message: 'Rounded to the nearest step.' }],
      },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(screen.getByText('Warnings')).toBeInTheDocument());
    expect(screen.queryByText('Skipped rows')).not.toBeInTheDocument();
    expect(screen.getByText(/Row 2 · Probability:/)).toBeInTheDocument();
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

  it('falls back to the generic message when the failure is not an axios error', async () => {
    postMock.mockRejectedValueOnce(new Error('socket hang up'));
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't import this file\. Check it's a CSV and try again\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/socket hang up/)).not.toBeInTheDocument();
  });

  it('falls back to the generic message when the axios error carries no response body', async () => {
    postMock.mockRejectedValueOnce({ isAxiosError: true });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't import this file\. Check it's a CSV and try again\./),
      ).toBeInTheDocument(),
    );
  });

  it('falls back to the generic message when `detail` is not a string', async () => {
    postMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { detail: { file: ['Unsupported media type.'] } } },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't import this file\. Check it's a CSV and try again\./),
      ).toBeInTheDocument(),
    );
  });

  it('shows the named file and a progress bar while the upload is in flight', async () => {
    postMock.mockReturnValueOnce(new Promise(() => {}));
    renderModal();
    selectFile('quarterly-risks.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(screen.getByText(/Importing quarterly-risks\.csv…/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('progressbar', { name: 'Importing file' })).toBeInTheDocument();
    // The idle controls are gone while uploading.
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('returns to the dropzone from the result view via "Import another"', async () => {
    postMock.mockResolvedValueOnce({
      data: { imported: 1, skipped: 0, errors: [], warnings: [] },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/Imported 1 risk\./)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Import another' }));

    expect(screen.queryByText(/Imported 1 risk\./)).not.toBeInTheDocument();
    // Back to an empty dropzone with Import re-disabled.
    expect(screen.getByRole('button', { name: /Choose file or drag one here/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('closes from the result view via "Done"', async () => {
    postMock.mockResolvedValueOnce({
      data: { imported: 1, skipped: 0, errors: [], warnings: [] },
    });
    const { onClose } = renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/Imported 1 risk\./)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns to the dropzone from the error view via "Try a different file"', async () => {
    postMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { detail: 'Malformed CSV header.' } },
    });
    renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/Malformed CSV header\./)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Try a different file' }));

    expect(screen.queryByText(/Malformed CSV header\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose file or drag one here/ })).toBeInTheDocument();
  });

  it('closes from the error view via "Close"', async () => {
    postMock.mockRejectedValueOnce(new Error('nope'));
    const { onClose } = renderModal();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't import this file/)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a dropzone rejection and clears it once a valid file is chosen', () => {
    renderModal();
    const zone = screen.getByRole('button', { name: /Choose file or drag one here/ });
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/That file can't be imported/);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    selectFile();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('re-disables Import when the selected file is removed', () => {
    renderModal();
    selectFile();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Choose file or drag one here/ })).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores keys that are neither Escape nor Tab', () => {
    const { onClose, container } = renderModal();
    const { last } = focusRing(container);
    last.focus();

    fireEvent.keyDown(document, { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });

  it('wraps Tab from the last focusable back to the first', () => {
    const { container } = renderModal();
    const { first, last } = focusRing(container);
    last.focus();

    const prevented = !fireEvent.keyDown(document, { key: 'Tab' });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    const { container } = renderModal();
    const { first, last } = focusRing(container);
    first.focus();

    const prevented = !fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('leaves Tab alone in the middle of the ring, in both directions', () => {
    const { container } = renderModal();
    const { middle } = focusRing(container);
    middle.focus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(middle);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(middle);
  });

  describe('focus restoration', () => {
    let trigger: HTMLButtonElement;

    beforeEach(() => {
      trigger = document.createElement('button');
      trigger.textContent = 'Import risks';
      document.body.appendChild(trigger);
    });

    afterEach(() => trigger.remove());

    it('moves focus into the dialog on open and back to the trigger on close', () => {
      trigger.focus();
      const { unmount } = renderModal();

      expect(document.activeElement).toBe(screen.getByRole('dialog'));

      unmount();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
