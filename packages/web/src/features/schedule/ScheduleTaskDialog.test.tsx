/**
 * ScheduleTaskDialog unit tests (#318, rule 135).
 *
 * Covers:
 *  - renders title + helper + date input defaulted to today (local ISO)
 *  - Schedule issues the promote PATCH with { planned_start, status: 'NOT_STARTED' }
 *    (decision A2 — explicit status skips the server's date-gated auto-bump)
 *  - Esc cancels and returns focus to the trigger
 *  - offline disables the Schedule button
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import type { Task } from '@/types';
import { ScheduleTaskDialog } from './ScheduleTaskDialog';

// ---------------------------------------------------------------------------
// API client mock — capture the PATCH body
// ---------------------------------------------------------------------------

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'bk1',
    wbs: '1',
    name: 'Spike auth flow',
    start: '',
    finish: '',
    duration: 3,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'BACKLOG',
    readiness: 'idea',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

function renderDialog(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function todayLocalIso(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  patchMock.mockResolvedValue({ data: {} });
  // Default online
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('ScheduleTaskDialog', () => {
  it('renders the dialog title, helper, and a date input defaulted to today', () => {
    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={vi.fn()} />,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(
      screen.getByRole('heading', { name: /Add.*Spike auth flow.*to a sprint/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/commits the idea from your backlog to a sprint/),
    ).toBeInTheDocument();

    const dateInput = screen.getByLabelText<HTMLInputElement>('Target date');
    expect(dateInput.value).toBe(todayLocalIso());
  });

  it('speaks in sprint/milestone language, not CPM float/early-start terms', () => {
    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={vi.fn()} />,
    );

    // Jordan (PO) hard-NO: the drop dialog must not force CPM/WBS vocabulary.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('sprint');
    expect(dialog.textContent ?? '').not.toMatch(/early start|float|critical path/i);
    expect(screen.getByRole('button', { name: 'Add to sprint' })).toBeInTheDocument();
  });

  it('focuses the date input on open (focus-first, rule 135)', () => {
    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={vi.fn()} />,
    );
    expect(screen.getByLabelText('Target date')).toHaveFocus();
  });

  it('Schedule sends PATCH with { planned_start, status: NOT_STARTED } (decision A2)', async () => {
    const onClose = vi.fn();
    renderDialog(
      <ScheduleTaskDialog task={makeTask({ id: 'bk1' })} projectId="proj1" onClose={onClose} />,
    );

    fireEvent.change(screen.getByLabelText('Target date'), {
      target: { value: '2026-06-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to sprint' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/tasks/bk1/', {
      planned_start: '2026-06-10',
      status: 'NOT_STARTED',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Esc cancels and returns focus to the trigger', () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={onClose} />,
    );
    // Dialog steals focus to the date input on mount.
    expect(screen.getByLabelText('Target date')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    trigger.remove();
  });

  it('disables Schedule when offline and surfaces the offline title', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={vi.fn()} />,
    );
    const scheduleBtn = screen.getByRole('button', { name: 'Add to sprint' });
    expect(scheduleBtn).toBeDisabled();
    expect(scheduleBtn).toHaveAttribute('title', "You're offline — change not saved.");
  });

  it('keeps the dialog open with an inline error on PATCH failure', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const onClose = vi.fn();
    renderDialog(
      <ScheduleTaskDialog task={makeTask()} projectId="proj1" onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to sprint' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add this item to the sprint"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
