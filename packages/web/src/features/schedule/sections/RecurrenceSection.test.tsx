import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { RecurrenceSection } from './RecurrenceSection';
import type { TaskRecurrenceRule } from '@/hooks/useRecurrenceRule';

// ---------------------------------------------------------------------------
// Module mocks (vitest requires the `mock` prefix to reference these in factories)
// ---------------------------------------------------------------------------

const mockRecurrence: { rule: TaskRecurrenceRule | null; isLoading: boolean; error: unknown } = {
  rule: null,
  isLoading: false,
  error: null,
};
const mockRole: { role: number | null; isLoading: boolean } = { role: 400, isLoading: false };
type MutateOptions = { onSuccess?: () => void; onError?: (error: unknown) => void };
const mockMutate = vi.fn<(vars: unknown, opts?: MutateOptions) => void>();
const mockCreate = { mutate: mockMutate, isPending: false };
const mockUpdate = { mutate: mockMutate, isPending: false };
const mockRemove = { mutate: vi.fn(), isPending: false, isError: false };

vi.mock('@/hooks/useRecurrenceRule', () => ({
  useRecurrenceRule: () => mockRecurrence,
  useCreateRecurrenceRule: () => mockCreate,
  useUpdateRecurrenceRule: () => mockUpdate,
  useDeleteRecurrenceRule: () => mockRemove,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => mockRole,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROLE_MEMBER = 100;
const ROLE_OWNER = 400;

function fixtureRule(overrides: Partial<TaskRecurrenceRule> = {}): TaskRecurrenceRule {
  return {
    id: 'rule-1',
    server_version: 1,
    task: 't1',
    frequency: 'WEEKLY',
    interval: 1,
    weekdays: 1,
    day_of_month: null,
    time_of_day: '09:00:00',
    timezone: 'UTC',
    end_type: 'NEVER',
    end_date: null,
    end_count: null,
    inherit_assignee: true,
    inherit_subtasks: false,
    inherit_attachments: false,
    inherit_morning_notification: false,
    generated_through: null,
    occurrence_count: 0,
    ...overrides,
  };
}

const render = (canEdit = false) =>
  renderWithProviders(<RecurrenceSection taskId="t1" projectId="p1" canEdit={canEdit} />);

beforeEach(() => {
  mockRecurrence.rule = null;
  mockRecurrence.isLoading = false;
  mockRecurrence.error = null;
  mockRole.role = ROLE_OWNER;
  mockRole.isLoading = false;
  mockMutate.mockReset();
  mockCreate.isPending = false;
  mockUpdate.isPending = false;
  mockRemove.mutate.mockReset();
  mockRemove.isPending = false;
  mockRemove.isError = false;
});

describe('RecurrenceSection states', () => {
  it('shows a loading skeleton while the rule is loading', () => {
    mockRecurrence.isLoading = true;
    render();
    expect(screen.getByLabelText('Loading recurrence')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', () => {
    mockRecurrence.error = new Error('boom');
    render();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load the recurrence/i);
  });

  it('empty state for a Scheduler+ shows an Add recurrence button', () => {
    render(true);
    expect(screen.getByText(/doesn't repeat/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeInTheDocument();
  });

  it('empty state for a read-only member hides the Add button', () => {
    mockRole.role = ROLE_MEMBER;
    render();
    expect(screen.getByText(/doesn't repeat/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add recurrence' })).not.toBeInTheDocument();
  });
});

describe('RecurrenceSection configured rule', () => {
  it('read-only member sees the CPM banner, a summary, and the preview but no edit button', () => {
    mockRole.role = ROLE_MEMBER;
    mockRecurrence.rule = fixtureRule();
    render();
    expect(screen.getByText(/CPM compute/i)).toBeInTheDocument();
    expect(screen.getByText('Next 4 occurrences')).toBeInTheDocument();
    expect(screen.getByText(/Every week on Mon at 09:00/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit recurrence/i })).not.toBeInTheDocument();
  });

  it('Scheduler+ sees an Edit recurrence button on a configured rule', () => {
    mockRecurrence.rule = fixtureRule();
    render(true);
    expect(screen.getByRole('button', { name: 'Edit recurrence' })).toBeInTheDocument();
  });
});

describe('RecurrenceSection form', () => {
  it('opening the create form shows the banner and renders deferred toggles disabled + labeled', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));

    // Banner is always present in the editor.
    expect(screen.getByText(/CPM compute/i)).toBeInTheDocument();

    // Active toggles are enabled; deferred ones are disabled and flagged.
    expect(screen.getByRole('checkbox', { name: /Inherit assignees/i })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Inherit subtasks/i })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Notify assignees the morning of/i })).toBeDisabled();
    expect(screen.getAllByText('Not active yet')).toHaveLength(2);
  });

  it('weekly default selects the weekday picker and shows a live preview', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // Weekly is the default → the weekday group renders.
    expect(screen.getByRole('group', { name: 'Days of week' })).toBeInTheDocument();
    expect(screen.getByText('Next 4 occurrences')).toBeInTheDocument();
  });

  it('selected frequency pill uses navy-on-sage fill, not white-on-sage (#1025, WCAG 1.4.3)', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    const freqGroup = screen.getByRole('group', { name: 'Repeat frequency' });
    const selected = freqGroup.querySelector('button[aria-pressed="true"]');
    expect(selected).not.toBeNull();
    // The active toggle fill flips to sage-400 in dark mode; navy ink keeps it
    // ≈ 6.8:1 (the old white-on-sage-400 was ≈ 1.8:1).
    expect(selected!.className).toContain('text-navy-900');
    expect(selected!.className).toContain('dark:bg-sage-400');
    expect(selected!.className).not.toContain('text-white');
  });

  it('blocks save and surfaces a message when a weekly rule has no weekday', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // Deselect the only selected weekday (today's). Toggle every set day off by
    // clicking the pressed ones, then attempt save.
    const dayButtons = screen.getByRole('group', { name: 'Days of week' }).querySelectorAll('button');
    dayButtons.forEach((btn) => {
      if (btn.getAttribute('aria-pressed') === 'true') fireEvent.click(btn);
    });
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeDisabled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('saves a valid rule via the create mutation', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // Switch to Daily — no weekday needed, always valid.
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ task: 't1', frequency: 'DAILY' });
  });
});

// ---------------------------------------------------------------------------
// Extended coverage: frequency switching, interval, end conditions,
// timezone/time, toggles, update/delete flows, error handling, and the
// read-only summary variants.
// ---------------------------------------------------------------------------

function openCreateForm() {
  render(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
}

describe('RecurrenceForm — frequency switching', () => {
  it('DAILY hides the interval row (every day is fixed to interval 1)', () => {
    openCreateForm();
    // Weekly shows the interval row by default.
    expect(screen.getByLabelText(/Interval in weeks/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(screen.queryByLabelText(/Interval in days/i)).not.toBeInTheDocument();
    // The weekday picker also disappears when leaving Weekly.
    expect(screen.queryByRole('group', { name: 'Days of week' })).not.toBeInTheDocument();
  });

  it('MONTHLY reveals a day-of-month input and hides the weekday picker', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.getByLabelText('Day of month')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Days of week' })).not.toBeInTheDocument();
    // Interval unit relabels to "months".
    expect(screen.getByLabelText(/Interval in months/i)).toBeInTheDocument();
  });

  it('CUSTOM keeps the interval row labeled in days and hides weekday/day-of-month', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByLabelText(/Interval in days/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Days of week' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  });

  it('interval input clamps sub-1 values back to 1', () => {
    openCreateForm();
    const interval = screen.getByLabelText<HTMLInputElement>(/Interval in weeks/i);
    fireEvent.change(interval, { target: { value: '3' } });
    expect(interval.value).toBe('3');
    fireEvent.change(interval, { target: { value: '0' } });
    expect(interval.value).toBe('1');
  });
});

describe('RecurrenceForm — end conditions', () => {
  it('selecting "On" enables the date input and disabling save until a date is chosen', () => {
    openCreateForm();
    // Switch to daily so the only client error can be the missing end date.
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    const dateInput = screen.getByLabelText<HTMLInputElement>('End date');
    expect(dateInput).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    expect(dateInput).toBeEnabled();
    // ON_DATE without a date is invalid → save disabled.
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeDisabled();

    fireEvent.change(dateInput, { target: { value: '2027-05-31' } });
    expect(dateInput.value).toBe('2027-05-31');
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeEnabled();
  });

  it('selecting "After" seeds a default count of 12 and enables the occurrence input', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    const countInput = screen.getByLabelText<HTMLInputElement>('Number of occurrences');
    expect(countInput).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'After' }));
    expect(countInput).toBeEnabled();
    expect(countInput.value).toBe('12');
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeEnabled();
  });

  it('clearing the "After" count invalidates the rule and disables save', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('radio', { name: 'After' }));
    const countInput = screen.getByLabelText<HTMLInputElement>('Number of occurrences');
    fireEvent.change(countInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeDisabled();
  });

  it('switching back to "Never" clears the end date and re-enables save', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-05-31' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Never' }));
    const dateInput = screen.getByLabelText<HTMLInputElement>('End date');
    expect(dateInput).toBeDisabled();
    expect(dateInput.value).toBe('');
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeEnabled();
  });

  it('saving an AFTER_N daily rule sends the end fields to the create mutation', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('radio', { name: 'After' }));
    fireEvent.change(screen.getByLabelText('Number of occurrences'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({
      frequency: 'DAILY',
      end_type: 'AFTER_N',
      end_count: 5,
    });
  });
});

describe('RecurrenceForm — time, timezone, monthly day, and toggles', () => {
  it('editing the time of day updates the control value', () => {
    openCreateForm();
    const time = screen.getByLabelText<HTMLInputElement>('Time of day');
    fireEvent.change(time, { target: { value: '14:30' } });
    expect(time.value).toBe('14:30');
  });

  it('a monthly day-of-month can be cleared and re-entered', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    const dom = screen.getByLabelText<HTMLInputElement>('Day of month');
    fireEvent.change(dom, { target: { value: '' } });
    // Empty day-of-month is invalid for MONTHLY → save disabled.
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeDisabled();
    fireEvent.change(dom, { target: { value: '15' } });
    expect(dom.value).toBe('15');
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeEnabled();
  });

  it('an out-of-range monthly day (>31) disables save', () => {
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '40' } });
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeDisabled();
  });

  it('toggling the active "Inherit assignees" checkbox flips it off', () => {
    openCreateForm();
    const assignees = screen.getByRole<HTMLInputElement>('checkbox', { name: /Inherit assignees/i });
    expect(assignees.checked).toBe(true);
    fireEvent.click(assignees);
    expect(assignees.checked).toBe(false);
  });

  it('a deferred toggle is disabled and carries a "Not active yet" pill', () => {
    openCreateForm();
    const subtasks = screen.getByRole<HTMLInputElement>('checkbox', { name: /Inherit subtasks/i });
    expect(subtasks).toBeDisabled();
    expect(subtasks.checked).toBe(false);
    // The deferred badge sits alongside it.
    expect(screen.getAllByText('Not active yet').length).toBeGreaterThan(0);
  });
});

describe('RecurrenceForm — save/cancel lifecycle', () => {
  it('Cancel returns to the empty state without mutating', () => {
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Back to the empty-state note + Add button.
    expect(screen.getByText(/doesn't repeat/i)).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('shows the saving spinner label and disables the button while a create is pending', () => {
    mockCreate.isPending = true;
    openCreateForm();
    const saveBtn = screen.getByRole('button', { name: 'Saving…' });
    expect(saveBtn).toBeDisabled();
  });

  it('a successful create closes the form back to the empty state', () => {
    mockMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // onSuccess → onClose → editing false → empty state (rule still null in mock).
    expect(screen.getByRole('button', { name: 'Add recurrence' })).toBeInTheDocument();
  });

  it('a create server error surfaces the joined DRF message', () => {
    mockMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { data: { weekdays: ['Pick a weekday.'], detail: 'Bad input' } } }),
    );
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a weekday. Bad input');
  });

  it('falls back to a generic message when the error has no readable body', () => {
    mockMutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('network')));
    openCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not save the recurrence/i);
  });
});

describe('RecurrenceForm — editing an existing rule', () => {
  it('opens with the rule draft and a "Save recurrence" label, then PATCHes via update', () => {
    mockUpdate.mutate = mockMutate;
    mockRecurrence.rule = fixtureRule({ frequency: 'WEEKLY', weekdays: 1 });
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit recurrence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save recurrence' }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toMatchObject({
      ruleId: 'rule-1',
      taskId: 't1',
      patch: expect.objectContaining({ frequency: 'WEEKLY' }) as unknown,
    });
  });
});

describe('RecurrenceForm — stop / delete flow', () => {
  function openEditForm() {
    mockRecurrence.rule = fixtureRule();
    render(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit recurrence' }));
  }

  it('"Stop recurring" reveals an inline confirm with a keep-occurrences note', () => {
    openEditForm();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recurring' }));
    expect(screen.getByText(/Existing occurrences are kept/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm stop' })).toBeInTheDocument();
  });

  it('confirming stop calls the delete mutation with the rule and task ids', () => {
    openEditForm();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recurring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    expect(mockRemove.mutate).toHaveBeenCalledTimes(1);
    expect(mockRemove.mutate.mock.calls[0][0]).toMatchObject({ ruleId: 'rule-1', taskId: 't1' });
  });

  it('"Keep" dismisses the confirm without deleting', () => {
    openEditForm();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recurring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByRole('button', { name: 'Confirm stop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop recurring' })).toBeInTheDocument();
    expect(mockRemove.mutate).not.toHaveBeenCalled();
  });

  it('Escape on the focused confirm button cancels the delete', () => {
    openEditForm();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recurring' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm stop' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Confirm stop' })).not.toBeInTheDocument();
    expect(mockRemove.mutate).not.toHaveBeenCalled();
  });

  it('shows the pending "Stopping…" label while the delete is in flight', () => {
    mockRemove.isPending = true;
    openEditForm();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recurring' }));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('surfaces a delete-error alert when the mutation failed', () => {
    mockRemove.isError = true;
    openEditForm();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't stop the recurrence/i);
  });
});

describe('RecurrenceReadOnly — human summary variants', () => {
  const showSummary = (overrides: Partial<TaskRecurrenceRule>) => {
    mockRole.role = ROLE_MEMBER;
    mockRecurrence.rule = fixtureRule(overrides);
    render();
  };

  it('describes a daily rule', () => {
    showSummary({ frequency: 'DAILY', weekdays: 0 });
    expect(screen.getByText(/Every day at 09:00/i)).toBeInTheDocument();
  });

  it('describes a multi-week rule with plural weeks and multiple days', () => {
    showSummary({ frequency: 'WEEKLY', interval: 2, weekdays: 1 | 4 });
    expect(screen.getByText(/Every 2 weeks on Mon, Wed at 09:00/i)).toBeInTheDocument();
  });

  it('describes a monthly rule with its day-of-month', () => {
    showSummary({ frequency: 'MONTHLY', weekdays: 0, day_of_month: 15 });
    expect(screen.getByText(/Every month on day 15 at 09:00/i)).toBeInTheDocument();
  });

  it('describes a custom every-N-days rule', () => {
    showSummary({ frequency: 'CUSTOM', interval: 3, weekdays: 0 });
    expect(screen.getByText(/Every 3 days at 09:00/i)).toBeInTheDocument();
  });

  it('appends the end date for an ON_DATE rule', () => {
    showSummary({ frequency: 'DAILY', weekdays: 0, end_type: 'ON_DATE', end_date: '2027-05-31' });
    expect(screen.getByText(/ends 2027-05-31/i)).toBeInTheDocument();
  });

  it('appends the occurrence count for an AFTER_N rule', () => {
    showSummary({ frequency: 'DAILY', weekdays: 0, end_type: 'AFTER_N', end_count: 5 });
    expect(screen.getByText(/5 occurrences/i)).toBeInTheDocument();
  });

  it('shows the empty-preview message for a rule that never fires', () => {
    showSummary({ frequency: 'WEEKLY', weekdays: 0 });
    expect(screen.getByText(/doesn't produce any upcoming occurrences/i)).toBeInTheDocument();
  });
});

describe('RecurrenceSection — role gating edge cases', () => {
  it('a configured rule with the role still null renders read-only (pessimistic gate)', () => {
    mockRole.role = null;
    mockRecurrence.rule = fixtureRule();
    render(true);
    // canEdit=true but role unresolved → not editable → no Edit button.
    expect(screen.queryByRole('button', { name: 'Edit recurrence' })).not.toBeInTheDocument();
    expect(screen.getByText(/Every week on Mon at 09:00/i)).toBeInTheDocument();
  });

  it('canEdit=false denies editing even for an Owner (server verdict wins)', () => {
    mockRole.role = ROLE_OWNER;
    mockRecurrence.rule = fixtureRule();
    render(false);
    expect(screen.queryByRole('button', { name: 'Edit recurrence' })).not.toBeInTheDocument();
  });
});
