import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewProgramModal } from './NewProgramModal';

const postMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...args) as Promise<unknown>,
    get: (...args: unknown[]) => getMock(...args) as Promise<unknown>,
  },
}));

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('NewProgramModal', () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
    // `/keys/` (ADR-1237): a name suggests a slug; any typed key is free.
    getMock.mockImplementation((_url: string, cfg: { params: { name?: string; key?: string } }) =>
      Promise.resolve({
        data:
          cfg.params.key !== undefined
            ? { available: true, reason: null, suggestion: cfg.params.key }
            : { suggestion: 'phase-2' },
      }),
    );
  });

  it('renders the cascading-access onboarding hint', () => {
    renderWithClient(<NewProgramModal onClose={() => {}} onCreated={() => {}} />);
    expect(
      screen.getByText(/Project access is managed separately on each project/i),
    ).toBeInTheDocument();
  });

  it('does not call the API when name is empty', () => {
    renderWithClient(<NewProgramModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /create program/i }));
    expect(postMock).not.toHaveBeenCalled();
  });

  it('submits with HYBRID methodology by default', async () => {
    postMock.mockResolvedValueOnce({
      data: { id: 'p-1', name: 'Phase 2', methodology: 'HYBRID' },
    });
    const onCreated = vi.fn();
    renderWithClient(<NewProgramModal onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Phase 2' } });
    fireEvent.click(screen.getByRole('button', { name: /create program/i }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('p-1');
    });
    expect(postMock).toHaveBeenCalledWith('/programs/', {
      name: 'Phase 2',
      description: '',
      methodology: 'HYBRID',
      // No `code`: submitted before the debounced suggestion landed, which is legal —
      // the server derives the key from the name (ADR-1237 §1).
    });
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderWithClient(<NewProgramModal onClose={onClose} onCreated={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('lowercases a typed program key and sends it', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'p-1', name: 'Phase 2', methodology: 'HYBRID' } });
    renderWithClient(<NewProgramModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Phase 2' } });
    const key = screen.getByRole('textbox', { name: 'Key' });
    fireEvent.change(key, { target: { value: 'Atlas-Launch' } });
    expect(key).toHaveValue('atlas-launch');
    await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /create program/i }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/programs/',
        expect.objectContaining({ code: 'atlas-launch' }),
      ),
    );
  });

  it('shows a 400 on code in the key status line, not the form alert', async () => {
    const { AxiosError, AxiosHeaders } = await import('axios');
    const headers = new AxiosHeaders();
    postMock.mockRejectedValueOnce(
      new AxiosError('Bad Request', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        data: { code: ['That word is reserved.'] },
        headers,
        config: { headers },
      }),
    );
    renderWithClient(<NewProgramModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Phase 2' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Key' }), {
      target: { value: 'settings' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create program/i }));
    const key = screen.getByRole('textbox', { name: 'Key' });
    await waitFor(() => expect(key).toHaveAccessibleDescription(/That word is reserved\./));
    expect(key).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
