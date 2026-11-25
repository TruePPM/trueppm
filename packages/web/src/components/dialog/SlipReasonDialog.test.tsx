import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { requestSlipReason } from '@/stores/slipReasonPromptStore';
import { isSlipReasonRequired } from '@/api/conflict';
import { SlipReasonDialog } from './SlipReasonDialog';

describe('SlipReasonDialog (ADR-1485 D1)', () => {
  it('renders nothing until a reason is requested', () => {
    render(<SlipReasonDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves with the trimmed reason on submit', async () => {
    render(<SlipReasonDialog />);
    let pending!: Promise<string | null>;
    act(() => {
      pending = requestSlipReason();
    });
    const submit = screen.getByRole('button', { name: 'Move it' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Vendor late  ' } });
    fireEvent.click(submit);
    await expect(pending).resolves.toBe('Vendor late');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves null when canceled, so the dates stay unchanged', async () => {
    render(<SlipReasonDialog />);
    let pending!: Promise<string | null>;
    act(() => {
      pending = requestSlipReason();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keep dates' }));
    await expect(pending).resolves.toBeNull();
  });

  it('a second request cancels the first', async () => {
    let first!: Promise<string | null>;
    act(() => {
      first = requestSlipReason();
      void requestSlipReason();
    });
    await expect(first).resolves.toBeNull();
  });
});

describe('isSlipReasonRequired', () => {
  const axiosError = (status: number, data: unknown) => ({
    isAxiosError: true,
    response: { status, data },
  });

  it('matches a 400 carrying a slip_reason field error', () => {
    expect(isSlipReasonRequired(axiosError(400, { slip_reason: ['Needs a reason.'] }))).toBe(true);
  });

  it('ignores other 400s and other statuses', () => {
    expect(isSlipReasonRequired(axiosError(400, { duration: ['Bad'] }))).toBe(false);
    expect(isSlipReasonRequired(axiosError(409, { slip_reason: ['x'] }))).toBe(false);
  });
});
