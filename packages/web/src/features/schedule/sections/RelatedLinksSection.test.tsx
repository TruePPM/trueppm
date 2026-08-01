import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import type { RelationCard, Task, TaskRelation } from '@/types';
import { RelatedLinksSection } from './RelatedLinksSection';

// The section owns no data of its own (ADR-0050) — every branch it renders is
// driven by the relations query, the schedule cache, and the project detail, so
// those three are the mock surface. The picker itself is rendered for real so
// the excluded-id / programId plumbing is asserted through what a user sees.
const { navigateSpy, deleteSpy, createSpy, relState, tasksState, projectState } = vi.hoisted(
  () => ({
    navigateSpy: vi.fn<(to: string) => void>(),
    deleteSpy: vi.fn<(relationId: string) => void>(),
    createSpy: vi.fn(),
    relState: {
      outgoing: [] as TaskRelation[],
      incoming: [] as TaskRelation[],
      isLoading: false,
      error: null as Error | null,
    },
    tasksState: { tasks: undefined as Task[] | undefined },
    projectState: { detail: undefined as { program: string | null } | undefined },
  }),
);

vi.mock('react-router', () => ({
  useNavigate: () => navigateSpy,
}));

vi.mock('@/hooks/useTaskRelations', () => ({
  useTaskRelations: () => relState,
  useDeleteTaskRelation: () => ({ mutate: deleteSpy, isPending: false }),
  useCreateTaskRelation: () => ({ mutate: createSpy, isPending: false }),
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: tasksState.tasks,
    links: undefined,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: projectState.detail }),
}));

vi.mock('@/features/programs/hooks/useProgramTaskSearch', () => ({
  useProgramTaskSearch: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-self',
    wbs: '1',
    name: 'Self task',
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    readiness: 'ready',
    assignees: [],
    notes: '',
    totalFloat: 0,
    ...overrides,
  } as Task;
}

function makeCard(overrides: Partial<RelationCard> = {}): RelationCard {
  return {
    id: 'x1',
    title: 'Security sign-off',
    hexId: 'SEC003',
    projectId: 'p-sec',
    projectName: 'Security',
    isMilestone: false,
    earlyStart: null,
    earlyFinish: null,
    isCritical: false,
    ...overrides,
  };
}

function makeRel(overrides: Partial<TaskRelation> = {}): TaskRelation {
  return {
    id: 'r1',
    source: 't-self',
    target: 't-other',
    relationType: 'relates_to',
    note: '',
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    sourceCard: null,
    targetCard: null,
    ...overrides,
  };
}

function renderSection(props: Partial<DrawerSectionProps> = {}) {
  return renderWithProviders(
    <RelatedLinksSection taskId="t-self" projectId="p1" canEdit {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  relState.outgoing = [];
  relState.incoming = [];
  relState.isLoading = false;
  relState.error = null;
  tasksState.tasks = [makeTask()];
  projectState.detail = { program: null };
  useScheduleStore.setState({ selectedTaskId: null });
});

describe('RelatedLinksSection — load states', () => {
  it('renders an alert instead of rows when the relations query fails', () => {
    relState.error = new Error('boom');
    relState.outgoing = [makeRel()];
    renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load related tasks/);
    expect(screen.queryByRole('button', { name: /Link task/ })).not.toBeInTheDocument();
  });

  it('takes the error branch even while the query is still loading', () => {
    relState.error = new Error('boom');
    relState.isLoading = true;
    renderSection();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Loading related tasks…')).not.toBeInTheDocument();
  });

  it('renders the loading line while relations are in flight', () => {
    relState.isLoading = true;
    renderSection();
    expect(screen.getByText('Loading related tasks…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the empty state, and still the write affordance, when there are no relations', () => {
    renderSection();
    expect(screen.getByText(/No related tasks\./)).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Link task/ })).toBeInTheDocument();
  });
});

describe('RelatedLinksSection — row resolution', () => {
  it('resolves a same-project counterpart from the schedule cache using its display reference (#2671)', () => {
    // A real 8-hex-digit `shortId` alongside the server-decoded display field —
    // the row must render qualifiedId/shortIdDisplay, never the raw hex.
    tasksState.tasks = [
      makeTask(),
      makeTask({
        id: 't-other',
        name: 'Foundation',
        shortId: '0000002A',
        shortIdDisplay: 'T-42',
        wbs: '2.1',
      }),
    ];
    relState.outgoing = [makeRel({ relationType: 'blocks' })];
    renderSection();
    expect(screen.getByRole('button', { name: 'Blocks, T-42, Foundation' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /0000002A/ }),
    ).not.toBeInTheDocument();
  });

  it('falls back to the WBS code when the cached task has no short id', () => {
    tasksState.tasks = [
      makeTask(),
      makeTask({ id: 't-other', name: 'Foundation', shortId: undefined, wbs: '2.1' }),
    ];
    relState.outgoing = [makeRel()];
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Relates to, 2.1, Foundation' }),
    ).toBeInTheDocument();
  });

  it('shows "Unknown task" and an em dash when the counterpart is not in the cache', () => {
    tasksState.tasks = [makeTask()];
    relState.outgoing = [makeRel()];
    renderSection();
    const row = screen.getByRole('button', { name: 'Relates to, Unknown task' });
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('labels an incoming relation with its inverse heading', () => {
    tasksState.tasks = [
      makeTask(),
      makeTask({
        id: 't-blocker',
        name: 'Permits',
        shortId: '00000001',
        shortIdDisplay: 'T-1',
        wbs: '1.4',
      }),
    ];
    relState.incoming = [
      makeRel({ id: 'r2', relationType: 'blocks', source: 't-blocker', target: 't-self' }),
    ];
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Blocked by, T-1, Permits' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Blocked by' })).toBeInTheDocument();
  });

  it('renders a cross-project counterpart from its card, with the project chip in the name', () => {
    relState.outgoing = [makeRel({ targetCard: makeCard() })];
    renderSection();
    const row = screen.getByRole('button', {
      name: 'Relates to, SEC003, Security sign-off, in Security',
    });
    expect(within(row).getByText('Security')).toBeInTheDocument();
  });

  it('reads an incoming relation from its sourceCard rather than the target id', () => {
    relState.incoming = [
      makeRel({
        id: 'r3',
        relationType: 'duplicates',
        source: 'x9',
        target: 't-self',
        sourceCard: makeCard({ id: 'x9', title: 'Legal go-ahead', hexId: 'LEG001', projectName: 'Legal' }),
      }),
    ];
    renderSection();
    expect(
      screen.getByRole('button', { name: 'Duplicated by, LEG001, Legal go-ahead, in Legal' }),
    ).toBeInTheDocument();
  });

  it('groups rows under canonical headings regardless of arrival order', () => {
    tasksState.tasks = [
      makeTask(),
      makeTask({ id: 'a', name: 'Alpha', shortId: 'A1' }),
      makeTask({ id: 'b', name: 'Bravo', shortId: 'B1' }),
      makeTask({ id: 'c', name: 'Charlie', shortId: 'C1' }),
    ];
    relState.outgoing = [
      makeRel({ id: 'r-dup', relationType: 'duplicates', target: 'c' }),
      makeRel({ id: 'r-blk', relationType: 'blocks', target: 'a' }),
    ];
    relState.incoming = [
      makeRel({ id: 'r-rel', relationType: 'relates_to', source: 'b', target: 't-self' }),
    ];
    renderSection();
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(['Relates to', 'Blocks', 'Duplicates']);
    // Two rows sharing a heading land in the same section.
    expect(
      within(screen.getByRole('region', { name: 'Blocks' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('collects several rows under one heading', () => {
    tasksState.tasks = [
      makeTask(),
      makeTask({ id: 'a', name: 'Alpha', shortId: 'A1' }),
      makeTask({ id: 'b', name: 'Bravo', shortId: 'B1' }),
    ];
    relState.outgoing = [
      makeRel({ id: 'r-1', target: 'a' }),
      makeRel({ id: 'r-2', target: 'b' }),
    ];
    renderSection();
    const section = screen.getByRole('region', { name: 'Relates to' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('RelatedLinksSection — row activation', () => {
  it('selects a same-project counterpart in the schedule instead of navigating', () => {
    tasksState.tasks = [makeTask(), makeTask({ id: 't-other', name: 'Foundation', shortId: 'F1' })];
    relState.outgoing = [makeRel()];
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Foundation/ }));
    expect(useScheduleStore.getState().selectedTaskId).toBe('t-other');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('navigates to the counterpart task page when it lives in another project', () => {
    relState.outgoing = [makeRel({ targetCard: makeCard({ id: 'x1', projectId: 'p-sec' }) })];
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Security sign-off/ }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p-sec/tasks/x1');
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('removes a relation through the row × control', () => {
    tasksState.tasks = [makeTask(), makeTask({ id: 't-other', name: 'Foundation' })];
    relState.outgoing = [makeRel({ id: 'rel-42' })];
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove relation' }));
    expect(deleteSpy).toHaveBeenCalledWith('rel-42');
  });
});

describe('RelatedLinksSection — write gating', () => {
  it('hides the remove control and the Link task trigger when canEdit is false', () => {
    tasksState.tasks = [makeTask(), makeTask({ id: 't-other', name: 'Foundation' })];
    relState.outgoing = [makeRel()];
    renderSection({ canEdit: false, userRole: ROLE_MEMBER });
    expect(screen.queryByRole('button', { name: 'Remove relation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link task/ })).not.toBeInTheDocument();
    // The row itself remains navigable for a read-only viewer.
    expect(screen.getByRole('button', { name: /Foundation/ })).toBeInTheDocument();
  });

  it('falls back to the client role rule when canEdit is absent — Viewer gets no controls', () => {
    tasksState.tasks = [makeTask(), makeTask({ id: 't-other', name: 'Foundation' })];
    relState.outgoing = [makeRel()];
    renderSection({ canEdit: undefined, userRole: ROLE_VIEWER });
    expect(screen.queryByRole('button', { name: 'Remove relation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link task/ })).not.toBeInTheDocument();
  });

  it('falls back to the client role rule when canEdit is absent — Member gets controls', () => {
    tasksState.tasks = [makeTask(), makeTask({ id: 't-other', name: 'Foundation' })];
    relState.outgoing = [makeRel()];
    renderSection({ canEdit: undefined, userRole: ROLE_MEMBER });
    expect(screen.getByRole('button', { name: 'Remove relation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Link task/ })).toBeInTheDocument();
  });

  it('prefers the server verdict over the client role rule', () => {
    renderSection({ canEdit: true, userRole: ROLE_VIEWER });
    expect(screen.getByRole('button', { name: /Link task/ })).toBeInTheDocument();
  });
});

describe('RelatedLinksSection — picker', () => {
  it('opens the picker with already-related counterparts and the task itself excluded', () => {
    tasksState.tasks = [
      makeTask(),
      makeTask({ id: 't-other', name: 'Foundation', shortId: 'F1' }),
      makeTask({ id: 't-free', name: 'Unlinked work', shortId: 'U1' }),
    ];
    relState.outgoing = [makeRel()];
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('option', { name: /Unlinked work/ })).toBeInTheDocument();
    // Foundation is already related, and the source task never lists itself.
    expect(within(dialog).queryByRole('option', { name: /Foundation/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /Self task/ })).not.toBeInTheDocument();
  });

  it('closes the picker again', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open a picker when the task is missing from the schedule cache', () => {
    tasksState.tasks = undefined;
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the program scope when the project belongs to a program', () => {
    projectState.detail = { program: 'prog-1' };
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));
    expect(screen.getByRole('tab', { name: 'Program' })).toBeInTheDocument();
  });

  it('hides the program scope for a standalone project, and while the project detail is unresolved', () => {
    projectState.detail = undefined;
    const { unmount } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    unmount();

    projectState.detail = { program: null };
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /Link task/ }));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
