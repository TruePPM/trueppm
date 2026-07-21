import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { EstimatesSection } from './EstimatesSection';
import type { Task } from '@/types';

// #2154: the estimates gating must derive from the threaded server per-task
// `canEdit` verdict AND the Scheduler/Admin role floor — in one place — not a
// separate useCurrentUserRole fork. Capture the flags EstimatesSection hands to
// EstimatesTab and assert they reflect `canEdit × role`.
const estimatesTabSpy = vi.hoisted(() => vi.fn());
vi.mock('../EstimatesTab', () => ({
  EstimatesTab: (props: { userIsScheduler: boolean; userIsAdmin?: boolean }) => {
    estimatesTabSpy(props);
    return <div data-testid="estimates-tab" />;
  },
}));

const task: Task = {
  id: 't1',
  wbs: '1',
  name: 'Widget work',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 7,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
};

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: [task], links: [], isLoading: false, error: null }),
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => ({ sprint: null }),
}));

const ROLE_SCHEDULER = 200;
const ROLE_ADMIN = 300;
const ROLE_MEMBER = 100;

beforeEach(() => estimatesTabSpy.mockClear());

function lastProps() {
  return estimatesTabSpy.mock.calls.at(-1)?.[0] as { userIsScheduler: boolean; userIsAdmin: boolean };
}

describe('EstimatesSection canEdit gating (#2154)', () => {
  it('grants scheduler+admin edit when the server verdict is editable and role is high enough', () => {
    renderWithProviders(
      <EstimatesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_ADMIN} />,
    );
    expect(lastProps()).toMatchObject({ userIsScheduler: true, userIsAdmin: true });
  });

  it('locks estimates when the server per-task verdict is NOT editable, even for an Admin role', () => {
    renderWithProviders(
      <EstimatesSection taskId="t1" projectId="p1" canEdit={false} userRole={ROLE_ADMIN} />,
    );
    expect(lastProps()).toMatchObject({ userIsScheduler: false, userIsAdmin: false });
  });

  it('applies the Scheduler floor — a Member with canEdit still cannot edit estimates', () => {
    renderWithProviders(
      <EstimatesSection taskId="t1" projectId="p1" canEdit userRole={ROLE_MEMBER} />,
    );
    expect(lastProps()).toMatchObject({ userIsScheduler: false, userIsAdmin: false });
  });

  it('falls back to the client role rule when canEdit is absent (pre-field synced rows)', () => {
    renderWithProviders(<EstimatesSection taskId="t1" projectId="p1" userRole={ROLE_SCHEDULER} />);
    expect(lastProps()).toMatchObject({ userIsScheduler: true, userIsAdmin: false });
  });
});
