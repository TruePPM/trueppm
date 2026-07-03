import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpdateStatusDialog } from './UpdateStatusDialog';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockedPatch = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    patch: (...args: unknown[]) => mockedPatch(...args) as unknown,
  },
}));

function renderDialog(props: Partial<Parameters<typeof UpdateStatusDialog>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UpdateStatusDialog
        projectId="proj-1"
        currentHealth="AUTO"
        canEdit
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  mockedPatch.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateStatusDialog', () => {
  it('renders as an accessible modal with the four health options', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: /update project status/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (const label of ['On track', 'At risk', 'Critical', 'Auto']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('pre-selects the current health via aria-pressed', () => {
    renderDialog({ currentHealth: 'AT_RISK' });
    expect(screen.getByRole('button', { name: 'At risk' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'On track' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps Save disabled until a different option is chosen', () => {
    renderDialog({ currentHealth: 'AUTO' });
    const save = screen.getByRole('button', { name: /save status/i });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Critical' }));
    expect(save).toBeEnabled();
  });

  it('golden path — PATCHes the chosen health and closes on success', async () => {
    mockedPatch.mockResolvedValue({ data: { id: 'proj-1', health: 'CRITICAL' } });
    const { onClose } = renderDialog({ currentHealth: 'AUTO' });
    fireEvent.click(screen.getByRole('button', { name: 'Critical' }));
    fireEvent.click(screen.getByRole('button', { name: /save status/i }));
    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/projects/proj-1/', { health: 'CRITICAL' });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('error state — surfaces the server error and stays open', async () => {
    mockedPatch.mockRejectedValue({
      response: { data: { health: ['You need at least Project Manager role.'] } },
    });
    const { onClose } = renderDialog({ currentHealth: 'AUTO' });
    fireEvent.click(screen.getByRole('button', { name: 'At risk' }));
    fireEvent.click(screen.getByRole('button', { name: /save status/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/at least Project Manager role/i);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('read-only for non-Admins — no Save, options disabled, PM note shown', () => {
    renderDialog({ canEdit: false, currentHealth: 'ON_TRACK' });
    expect(screen.queryByRole('button', { name: /save status/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'At risk' })).toBeDisabled();
    expect(screen.getByText(/only a project manager can change/i)).toBeInTheDocument();
    // The safe control reads "Close" rather than "Cancel" when nothing can change.
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('Escape triggers onClose', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
