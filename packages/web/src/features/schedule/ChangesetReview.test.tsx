import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ApiChangeset, ApiChangesetEntry } from '@/hooks/useChangeset';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { ChangesetReview } from './ChangesetReview';

const state = vi.hoisted(() => ({ data: undefined as unknown }));
const decideMutate = vi.hoisted(() => vi.fn());
const answerMutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useChangeset', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useChangeset')>()),
  useChangeset: () => ({ data: state.data, refetch: vi.fn() }),
  useBaselineDecision: () => ({ mutate: decideMutate, isPending: false }),
  useAnswerChangesetReason: () => ({ mutate: answerMutate, isPending: false }),
}));
vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function entry(over: Partial<ApiChangesetEntry>): ApiChangesetEntry {
  return {
    id: 'e1',
    kind: 'move',
    surface: 'grid',
    author: 1,
    author_name: 'kelly',
    task_ids: ['t1'],
    task_names: ['Pour'],
    reason: null,
    reason_state: 'unreasoned',
    reason_by_name: null,
    finish_before: '2026-03-20',
    finish_after: null,
    opened_at: '2026-03-21T10:00:00Z',
    last_act_at: '2026-03-21T10:00:00Z',
    closed_at: null,
    resolved_decision: null,
    ...over,
  };
}

function changeset(entries: ApiChangesetEntry[]): ApiChangeset {
  const unreasoned = entries.filter((e) => e.reason === null).length;
  return {
    project_id: 'p1',
    open_count: entries.length,
    unreasoned_count: unreasoned,
    reasoned_count: entries.length - unreasoned,
    active_baseline: 'b1',
    active_baseline_name: 'Baseline v1',
    finish_baseline: '2026-03-20',
    finish_current: '2026-03-27',
    net_delta_days: 7,
    last_kept_at: null,
    entries_since_kept: entries.length,
    entries,
  };
}

const takeButton = () => screen.getByRole('button', { name: 'Take new baseline' });
const keepButton = () => screen.getByRole('button', { name: /keep baseline/i });

describe('ChangesetReview', () => {
  beforeEach(() => {
    decideMutate.mockReset();
    answerMutate.mockReset();
  });

  it('renders nothing for a Member', () => {
    state.data = changeset([entry({})]);
    const { container } = render(<ChangesetReview projectId="p1" currentRole={ROLE_MEMBER} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a Scheduler answers reasons but sees no exits', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetReview projectId="p1" currentRole={ROLE_SCHEDULER} />);
    fireEvent.change(screen.getByLabelText(/needs a reason/i), {
      target: { value: 'Vendor slip' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save reason' }));
    expect(answerMutate).toHaveBeenCalledWith({ entryId: 'e1', reason: 'Vendor slip' });
    expect(screen.queryByRole('button', { name: 'Take new baseline' })).toBeNull();
  });

  it('blocks Take while a change needs a reason, and never blocks Keep', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetReview projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(takeButton()).toBeDisabled();
    expect(
      screen.getByText(/1 changes need a reason before this plan can be re-baselined/i),
    ).toBeInTheDocument();
    expect(keepButton()).toBeEnabled();
    fireEvent.click(keepButton());
    expect(decideMutate).toHaveBeenCalledWith(
      { kind: 'kept', expected_open_count: 1, note: '' },
      expect.any(Object),
    );
  });

  it('takes v2 once every change is reasoned and a code and reason are given', () => {
    state.data = changeset([entry({ reason: 'CO-7', reason_state: 'reasoned' })]);
    render(<ChangesetReview projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(takeButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason code'), {
      target: { value: 'approved_scope_change' },
    });
    fireEvent.change(screen.getByLabelText(/why was the plan re-agreed/i), {
      target: { value: 'Sponsor signed CO-7' },
    });
    fireEvent.click(takeButton());
    expect(decideMutate).toHaveBeenCalledWith(
      {
        kind: 'taken',
        expected_open_count: 1,
        reason_code: 'approved_scope_change',
        reason: 'Sponsor signed CO-7',
      },
      expect.any(Object),
    );
  });

  it('shows the two exits as identical buttons (coequal, no default)', () => {
    state.data = changeset([entry({ reason: 'x', reason_state: 'reasoned' })]);
    render(<ChangesetReview projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(takeButton().className).toBe(keepButton().className);
    expect(takeButton()).toHaveAttribute('type', 'button');
    expect(keepButton()).toHaveAttribute('type', 'button');
  });

  it('renders nothing when the changeset is empty', () => {
    state.data = changeset([]);
    const { container } = render(<ChangesetReview projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(container).toBeEmptyDOMElement();
  });
});
