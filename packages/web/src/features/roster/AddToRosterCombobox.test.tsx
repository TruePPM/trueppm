/**
 * AddToRosterCombobox inline-create failure test (#2150).
 *
 * The "+ Create '{name}' as a new resource" action had no error path — a failed
 * create just did nothing, leaving the user staring at the option. This covers
 * the toast that now surfaces the failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AddToRosterCombobox } from './AddToRosterCombobox';

const { getMock, postMock, toastErrorMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: toastErrorMock } }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { results: [] } });
  postMock.mockReset();
  toastErrorMock.mockReset();
});

describe('AddToRosterCombobox — inline-create failure feedback (#2150)', () => {
  it('toasts when creating the new resource fails', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    render(<AddToRosterCombobox projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />, {
      wrapper,
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'New Person' } });

    // The create option appears once the (empty) search resolves.
    const createOption = await screen.findByText(/\+ Create "New Person" as a new resource/);
    fireEvent.pointerDown(createOption);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Couldn't create the resource — try again."),
    );
  });
});
