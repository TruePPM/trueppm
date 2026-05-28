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
const mockMutate = vi.fn();
const mockRemove = { mutate: vi.fn(), isPending: false, isError: false };

vi.mock('@/hooks/useRecurrenceRule', () => ({
  useRecurrenceRule: () => mockRecurrence,
  useCreateRecurrenceRule: () => ({ mutate: mockMutate, isPending: false }),
  useUpdateRecurrenceRule: () => ({ mutate: mockMutate, isPending: false }),
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

const render = () => renderWithProviders(<RecurrenceSection taskId="t1" projectId="p1" />);

beforeEach(() => {
  mockRecurrence.rule = null;
  mockRecurrence.isLoading = false;
  mockRecurrence.error = null;
  mockRole.role = ROLE_OWNER;
  mockRole.isLoading = false;
  mockMutate.mockReset();
  mockRemove.mutate.mockReset();
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
    render();
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
    render();
    expect(screen.getByRole('button', { name: 'Edit recurrence' })).toBeInTheDocument();
  });
});

describe('RecurrenceSection form', () => {
  it('opening the create form shows the banner and renders deferred toggles disabled + labeled', () => {
    render();
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
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // Weekly is the default → the weekday group renders.
    expect(screen.getByRole('group', { name: 'Days of week' })).toBeInTheDocument();
    expect(screen.getByText('Next 4 occurrences')).toBeInTheDocument();
  });

  it('blocks save and surfaces a message when a weekly rule has no weekday', () => {
    render();
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
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    // Switch to Daily — no weekday needed, always valid.
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add recurrence' }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ task: 't1', frequency: 'DAILY' });
  });
});
