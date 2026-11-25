import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ApiChangeset, ApiChangesetEntry } from '@/hooks/useChangeset';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { ChangesetSheet, KEEP_UNDO_MS, finishImpact, shortBaselineName } from './ChangesetSheet';
import {
  ChangesetIndicator,
  ChangesetReasonLine,
  describeEntry,
  isReviewDemoted,
} from './ChangesetIndicator';

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  online: true,
  breakpoint: 'lg' as 'sm' | 'md' | 'lg',
}));
const decideMutate = vi.hoisted(() => vi.fn());
const answerMutate = vi.hoisted(() => vi.fn());
const toastAction = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useChangeset', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useChangeset')>()),
  useChangeset: () => ({ data: state.data, refetch: vi.fn() }),
  useBaselineDecision: () => ({
    mutateAsync: (body: unknown) => {
      decideMutate(body);
      return Promise.resolve({});
    },
    isPending: false,
  }),
  useAnswerChangesetReason: () => ({ mutate: answerMutate, isPending: false }),
}));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => state.online }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => state.breakpoint }));
vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), action: toastAction },
}));

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

function changeset(entries: ApiChangesetEntry[], over: Partial<ApiChangeset> = {}): ApiChangeset {
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
    net_delta_days: 5,
    last_kept_at: null,
    entries_since_kept: entries.length,
    entries,
    ...over,
  };
}

const reasoned = (id: string) => entry({ id, reason: 'CO-7', reason_state: 'reasoned' });
const takeButton = () => screen.getByRole('button', { name: 'Take baseline v2' });
const keepButton = () => screen.getByRole('button', { name: 'Keep v1 · let variance stand' });
const onClose = vi.fn();

beforeEach(() => {
  decideMutate.mockReset();
  answerMutate.mockReset();
  toastAction.mockReset();
  onClose.mockReset();
  state.online = true;
  state.breakpoint = 'lg';
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('ChangesetSheet (desktop, Pass 5 3C)', () => {
  it('lists unreasoned changes first even if the response is not ordered', () => {
    state.data = changeset([
      entry({ id: 'a', task_names: ['Answered'], reason: 'x', reason_state: 'reasoned' }),
      entry({ id: 'b', task_names: ['Open'] }),
    ]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Open');
    expect(items[1]).toHaveTextContent('Answered');
  });

  it('a Scheduler answers reasons but sees no exits', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_SCHEDULER} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/needs a reason/i), {
      target: { value: 'Vendor slip' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(answerMutate).toHaveBeenCalledWith(
      { entryId: 'e1', reason: 'Vendor slip' },
      expect.any(Object),
    );
    expect(screen.queryByRole('button', { name: /take baseline/i })).toBeNull();
  });

  it('blocks Take while a change needs a reason, and never blocks Keep', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    expect(takeButton()).toBeDisabled();
    expect(takeButton()).toHaveAccessibleDescription(/1 change needs a reason/i);
    fireEvent.click(keepButton());
    expect(decideMutate).toHaveBeenCalledWith({ kind: 'kept', expected_open_count: 1, note: '' });
  });

  it('takes v2 once every change is reasoned and a code and reason are given', () => {
    state.data = changeset([reasoned('e1')]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    expect(takeButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason · required'), {
      target: { value: 'approved_scope_change' },
    });
    fireEvent.change(screen.getByLabelText(/why re-baseline/i), {
      target: { value: 'Sponsor signed CO-7' },
    });
    fireEvent.click(takeButton());
    expect(decideMutate).toHaveBeenCalledWith({
      kind: 'taken',
      expected_open_count: 1,
      reason_code: 'approved_scope_change',
      reason: 'Sponsor signed CO-7',
    });
  });

  it('shows the two exits as identical buttons, and Enter in a field decides nothing', () => {
    state.data = changeset([reasoned('e1')]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    expect(takeButton().className).toBe(keepButton().className);
    expect(document.querySelector('form')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText(/note for the trail/i), { key: 'Enter' });
    expect(decideMutate).not.toHaveBeenCalled();
  });

  it('Esc and ✕ close without deciding', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close without deciding' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(decideMutate).not.toHaveBeenCalled();
  });

  it('offline: both exits disable with "Reconnect to decide" and the typed reason is kept', () => {
    state.data = changeset([reasoned('e1')]);
    state.online = false;
    const { unmount } = render(
      <ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />,
    );
    const offline = screen.getAllByRole('button', { name: 'Reconnect to decide' });
    expect(offline).toHaveLength(2);
    offline.forEach((b) => expect(b).toBeDisabled());
    fireEvent.change(screen.getByLabelText(/why re-baseline/i), {
      target: { value: 'Kept on device' },
    });
    unmount();
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    expect(screen.getByLabelText(/why re-baseline/i)).toHaveValue('Kept on device');
  });
});

describe('ChangesetSheet (phone, Pass 5 4A)', () => {
  beforeEach(() => {
    state.breakpoint = 'sm';
  });

  it('has two equal footer buttons; Take v2… opens the reason step', () => {
    state.data = changeset([reasoned('e1')]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    const take = screen.getByRole('button', { name: 'Take v2…' });
    const keep = screen.getByRole('button', { name: 'Keep v1' });
    expect(take.className).toBe(keep.className);
    fireEvent.click(take);
    expect(screen.getByRole('button', { name: 'Take baseline v2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep v1 instead' })).toBeEnabled();
  });

  it('Take v2… stays disabled while a change lacks a reason', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Take v2…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep v1' })).toBeEnabled();
  });

  it('Keep v1 is one tap with a 10 s Undo; the POST waits for the window', () => {
    vi.useFakeTimers();
    try {
      state.data = changeset([entry({})]);
      render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Keep v1' }));
      expect(toastAction).toHaveBeenCalled();
      expect(decideMutate).not.toHaveBeenCalled();
      void act(() => {
        vi.advanceTimersByTime(KEEP_UNDO_MS);
      });
      expect(decideMutate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kept' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Undo within the window sends nothing', () => {
    vi.useFakeTimers();
    try {
      state.data = changeset([entry({})]);
      render(<ChangesetSheet projectId="p1" currentRole={ROLE_ADMIN} onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Keep v1' }));
      const action = toastAction.mock.calls[0][1] as { onClick: () => void };
      action.onClick();
      void act(() => {
        vi.advanceTimersByTime(KEEP_UNDO_MS);
      });
      expect(decideMutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChangesetIndicator (Pass 5 3B pin 1, 3D)', () => {
  it('renders nothing for a Member or an empty changeset', () => {
    state.data = changeset([entry({})]);
    const { container, rerender } = render(
      <ChangesetIndicator projectId="p1" currentRole={ROLE_MEMBER} />,
    );
    expect(container).toBeEmptyDOMElement();
    state.data = changeset([]);
    rerender(<ChangesetIndicator projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the counts and a primary Review that opens the sheet', () => {
    state.data = changeset([entry({ id: 'a' }), reasoned('b'), reasoned('c')]);
    render(<ChangesetIndicator projectId="p1" currentRole={ROLE_SCHEDULER} />);
    expect(screen.getByTestId('changeset-counts')).toHaveTextContent(
      '◷ 3 changes open · 1 needs a reason',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review 3 changes' }));
    expect(screen.getByRole('dialog', { name: '3 changes since Baseline v1' })).toBeInTheDocument();
  });

  it('demotes Review to secondary after Keep v1 until a new change lands', () => {
    const kept = changeset([reasoned('a')], {
      last_kept_at: '2026-03-22T10:00:00Z',
      entries_since_kept: 0,
    });
    expect(isReviewDemoted(kept)).toBe(true);
    expect(isReviewDemoted({ ...kept, entries_since_kept: 1 })).toBe(false);
    state.data = kept;
    render(<ChangesetIndicator projectId="p1" currentRole={ROLE_ADMIN} />);
    expect(screen.getByRole('button', { name: '1 change · v1 kept' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull();
  });
});

describe('ChangesetReasonLine (Pass 5 3B pin 2)', () => {
  it('states the change in polite live text and never takes focus by itself', () => {
    state.data = changeset([entry({ finish_after: '2026-03-27' })]);
    render(<ChangesetReasonLine projectId="p1" currentRole={ROLE_SCHEDULER} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Pour moved · finish 2026-03-20 → 2026-03-27',
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(document.activeElement).toBe(document.body);
  });

  it('⌥W focuses the field; Enter saves the reason', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetReasonLine projectId="p1" currentRole={ROLE_SCHEDULER} />);
    fireEvent.keyDown(window, { code: 'KeyW', altKey: true });
    const input = screen.getByRole('textbox', { name: /why\?/i });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-keyshortcuts', 'Alt+W');
    fireEvent.change(input, { target: { value: 'Crane on site after Apr 24' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(answerMutate).toHaveBeenCalledWith(
      { entryId: 'e1', reason: 'Crane on site after Apr 24' },
      expect.any(Object),
    );
  });

  it('Esc or ✕ dismisses without answering', () => {
    state.data = changeset([entry({})]);
    render(<ChangesetReasonLine projectId="p1" currentRole={ROLE_SCHEDULER} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('changeset-reason-line')).toBeNull();
    expect(answerMutate).not.toHaveBeenCalled();
  });

  it('is hidden from Members', () => {
    state.data = changeset([entry({})]);
    const { container } = render(<ChangesetReasonLine projectId="p1" currentRole={ROLE_MEMBER} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('copy helpers', () => {
  it('names the system-side facts without guessing', () => {
    expect(shortBaselineName('Baseline v1')).toBe('v1');
    expect(finishImpact(entry({}))).toBe('impact not computed yet');
    expect(finishImpact(entry({ finish_after: '2026-03-20' }))).toBe('no date change');
    expect(describeEntry(entry({ task_ids: ['a', 'b'], task_names: ['A', 'B'] }))).toBe(
      '2 tasks moved in this session',
    );
  });
});
