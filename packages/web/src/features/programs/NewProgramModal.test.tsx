import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewProgramModal } from './NewProgramModal';

const postMock = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...args) as Promise<unknown>,
  },
}));

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('NewProgramModal', () => {
  beforeEach(() => {
    postMock.mockReset();
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
    });
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderWithClient(<NewProgramModal onClose={onClose} onCreated={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
