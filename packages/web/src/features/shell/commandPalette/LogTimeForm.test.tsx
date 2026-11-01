import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';

import { LogTimeForm } from './LogTimeForm';

const mutate = vi.fn();
const reset = vi.fn();
let hookState: { isPending: boolean; error: unknown } = { isPending: false, error: null };
const useCreate = vi.fn((_opts?: unknown) => ({ mutate, reset, ...hookState }));
vi.mock('@/hooks/useCreateTimeEntry', () => ({
  useCreateTimeEntry: (opts?: unknown) => useCreate(opts),
}));

const TARGET = { taskId: 't1', taskLabel: 'T-8 · Wire OAuth' };

afterEach(() => {
  hookState = { isPending: false, error: null };
  vi.clearAllMocks();
});

function setup() {
  const onBack = vi.fn();
  const onDone = vi.fn();
  render(<LogTimeForm target={TARGET} onBack={onBack} onDone={onDone} />);
  return { onBack, onDone };
}

describe('LogTimeForm', () => {
  it('opts out of the hook toast and focuses the minutes field', () => {
    setup();
    expect(useCreate).toHaveBeenCalledWith({ toastErrors: false });
    expect(screen.getByLabelText(/minutes/i)).toHaveFocus();
  });

  it('submits parsed minutes for the target task and calls onDone on success', () => {
    const { onDone } = setup();
    fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: '45' } });
    fireEvent.submit(screen.getByTestId('cmdk-log-time'));
    expect(mutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = mutate.mock.calls[0] as [
      { taskId: string; taskLabel: string; minutes: number; entryDate: string },
      { onSuccess: () => void },
    ];
    expect(vars).toMatchObject({ taskId: 't1', taskLabel: 'T-8 · Wire OAuth', minutes: 45 });
    expect(vars.entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    opts.onSuccess();
    expect(onDone).toHaveBeenCalled();
  });

  it('accepts hours and clock forms', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: '1:30' } });
    fireEvent.submit(screen.getByTestId('cmdk-log-time'));
    expect((mutate.mock.calls[0][0] as { minutes: number }).minutes).toBe(90);
  });

  it('blocks an unparseable value with an inline alert and no request', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: 'abc' } });
    fireEvent.submit(screen.getByTestId('cmdk-log-time'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/enter minutes/i);
  });

  it("renders the server's refusal inline as an alert", () => {
    hookState = {
      isPending: false,
      error: new AxiosError('bad', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { entry_date: ['Cannot log time in the future.'] },
      } as AxiosResponse),
    };
    setup();
    expect(screen.getByTestId('cmdk-log-time-error')).toHaveTextContent(
      'Cannot log time in the future.',
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Back returns to the list', () => {
    const { onBack } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('disables submit while pending', () => {
    hookState = { isPending: true, error: null };
    setup();
    expect(screen.getByRole('button', { name: /logging/i })).toBeDisabled();
  });
});
