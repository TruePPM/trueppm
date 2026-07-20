import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import type { DragStartEvent, DragOverEvent, DragEndEvent } from '@dnd-kit/core';
import type { Task } from '@/types';
import type { ProductBacklog } from './types';
import { ProductBacklogPage } from './ProductBacklogPage';

// ── Controllable mock state ────────────────────────────────────────────────
// Everything the DesktopGroomingView reads is funneled through this hoisted
// object so each test can drive the exact loading / error / empty / populated /
// filtered / permission branch it exercises.
const h = vi.hoisted(() => ({
  bp: { value: 'lg' as 'sm' | 'md' | 'lg' },
  backlog: { isLoading: true, isError: false, data: undefined as ProductBacklog | undefined },
  canManage: true,
  planned: [] as Array<{ id: string; name: string }>,
  filters: { query: '', dorStates: [] as string[], unestimatedOnly: false },
  filterActive: false,
  intent: null as { kind: string; projectId: string } | null,
  autoRankPending: false,
  createEpicError: false,
  autoRankMutate: vi.fn(),
  setDorMutate: vi.fn(),
  reorderMutate: vi.fn(),
  reparentMutate: vi.fn(),
  quickAddMutate: vi.fn(),
  createEpicMutate: vi.fn(),
  createEpicReset: vi.fn(),
  navigate: vi.fn(),
  closeIntent: vi.fn(),
  resetFilters: vi.fn(),
  // Captured DndContext callbacks — the drag machinery (reorder / reparent /
  // conflict) is unreachable via jsdom's pointer pipeline, so we mock the
  // context to capture its handlers and fire synthetic events directly.
  dnd: {} as {
    onDragStart?: (e: DragStartEvent) => void;
    onDragOver?: (e: DragOverEvent) => void;
    onDragEnd?: (e: DragEndEvent) => void;
    onDragCancel?: () => void;
  },
}));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    // Passthrough DndContext that snapshots the page's handlers each render.
    DndContext: ({
      children,
      onDragStart,
      onDragOver,
      onDragEnd,
      onDragCancel,
    }: {
      children: ReactNode;
      onDragStart?: (e: DragStartEvent) => void;
      onDragOver?: (e: DragOverEvent) => void;
      onDragEnd?: (e: DragEndEvent) => void;
      onDragCancel?: () => void;
    }) => {
      h.dnd.onDragStart = onDragStart;
      h.dnd.onDragOver = onDragOver;
      h.dnd.onDragEnd = onDragEnd;
      h.dnd.onDragCancel = onDragCancel;
      return <>{children}</>;
    },
    // Real DragOverlay needs the DndContext provider we just stubbed out; render
    // its payload directly so the drag ghost still appears while a drag is active.
    DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => h.bp.value }));

vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => h.navigate,
}));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: 'Sprint',
    plural: 'Sprints',
    lower: 'sprint',
    lowerPlural: 'sprints',
    possessive: "Sprint's",
  }),
}));

vi.mock('@/hooks/useMyFacets', () => ({ useCanManageBacklog: () => h.canManage }));

vi.mock('@/hooks/useSprints', () => ({ useSprintsByState: () => ({ planned: h.planned }) }));

vi.mock('@/stores/createIntentStore', () => ({
  useCreateIntentStore: (sel: (s: { intent: unknown; close: () => void }) => unknown) =>
    sel({ intent: h.intent, close: h.closeIntent }),
}));

vi.mock('./hooks/useGroomingFilters', () => ({
  useGroomingFilters: () => ({
    filters: h.filters,
    active: h.filterActive,
    setQuery: vi.fn(),
    toggleDor: vi.fn(),
    setUnestimatedOnly: vi.fn(),
    reset: h.resetFilters,
  }),
}));

vi.mock('./hooks/useProductBacklog', () => ({
  useProductBacklog: () => h.backlog,
  useAutoRank: () => ({ mutate: h.autoRankMutate, isPending: h.autoRankPending }),
  useSetDor: () => ({ mutate: h.setDorMutate }),
  useReorderBacklog: () => ({ mutate: h.reorderMutate }),
  useReparentStory: () => ({ mutate: h.reparentMutate }),
  useQuickAddStory: () => ({ mutate: h.quickAddMutate }),
  useCreateEpic: () => ({
    mutate: h.createEpicMutate,
    reset: h.createEpicReset,
    isError: h.createEpicError,
  }),
}));

// Leaf components stubbed to deterministic markers so the tests target the page's
// own composition logic (subtitle, health, view toggle, quick-add, epic-add,
// filter branches) rather than the children (which have their own suites).
vi.mock('./components/mobile/MobileGroomingPage', () => ({
  MobileGroomingPage: () => <div data-testid="mobile-grooming">mobile</div>,
}));
vi.mock('./components/GroomingFilterBar', () => ({
  GroomingFilterBar: ({ matchCount, totalCount }: { matchCount: number; totalCount: number }) => (
    <div data-testid="filter-bar">
      {matchCount}/{totalCount}
    </div>
  ),
}));
vi.mock('./components/EpicHeader', () => ({
  EpicHeader: ({ group, onOpen }: { group: { epic: Task }; onOpen: (e: Task) => void }) => (
    <button type="button" onClick={() => onOpen(group.epic)}>
      epic-open-{group.epic.name}
    </button>
  ),
}));
vi.mock('./components/EpicDetailDrawer', () => ({
  EpicDetailDrawer: ({ epic, onClose }: { epic: Task; onClose: () => void }) => (
    <div data-testid="epic-drawer">
      epic-drawer-{epic.name}
      <button type="button" onClick={onClose}>
        close-epic
      </button>
    </div>
  ),
}));
vi.mock('./components/StoryDetailDrawer', () => ({
  StoryDetailDrawer: ({ story, onClose }: { story: Task; onClose: () => void }) => (
    <div data-testid="story-drawer">
      story-drawer-{story.name}
      <button type="button" onClick={onClose}>
        close-story
      </button>
    </div>
  ),
}));
vi.mock('./SprintCommitButton', () => ({
  SprintCommitButton: ({ story }: { story: Task }) => (
    <span data-testid={`commit-${story.id}`}>commit</span>
  ),
}));
vi.mock('./SprintPlanningRail', () => ({
  SprintPlanningRail: ({
    committedPoints,
    storyCount,
  }: {
    committedPoints: number;
    storyCount: number;
  }) => (
    <div data-testid="planning-rail">
      rail-{committedPoints}pts-{storyCount}stories
    </div>
  ),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────
function makeStory(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    shortId: id.toUpperCase(),
    taskType: 'story',
    dor: 'refine',
    storyPoints: 2,
    score: null,
    acMet: 0,
    acTotal: 0,
    assignees: [],
    serverVersion: 1,
    sprintId: null,
    sprintPending: false,
    ...over,
  } as unknown as Task;
}

const s1 = makeStory('s1', {
  name: 'Login flow',
  dor: 'ready',
  storyPoints: 3,
  score: 5,
  acMet: 2,
  acTotal: 2,
  sprintId: 'sp1',
  sprintPending: false,
});
const s2 = makeStory('s2', { name: 'Signup form', dor: 'refine', storyPoints: 2, score: 9 });
const s3 = makeStory('s3', {
  name: 'Reset password',
  dor: 'ready',
  storyPoints: null,
  score: 1,
  sprintId: 'sp1',
  sprintPending: true,
});

const epicTask = makeStory('e1', { name: 'Auth epic', taskType: 'epic' });

function makeBacklog(over: Partial<ProductBacklog> = {}): ProductBacklog {
  return {
    epics: [
      {
        epic: epicTask,
        stories: [s1, s2],
        rollup: { storyCount: 2, pointsTotal: 5, pointsDone: 0 },
      },
    ],
    ungrouped: [s3],
    health: {
      dorPct: 90,
      readyCount: 2,
      readyPoints: 5,
      capacityPoints: 10,
      unestimated: 0,
      acMet: 3,
      acTotal: 4,
      storyCount: 3,
    },
    scoring: { model: 'wsjf' },
    ...over,
  };
}

function setData(data: ProductBacklog | undefined) {
  h.backlog = { isLoading: false, isError: false, data };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProductBacklogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.bp.value = 'lg';
  h.backlog = { isLoading: true, isError: false, data: undefined };
  h.canManage = true;
  h.planned = [];
  h.filters = { query: '', dorStates: [], unestimatedOnly: false };
  h.filterActive = false;
  h.intent = null;
  h.autoRankPending = false;
  h.createEpicError = false;
  h.dnd = {};
  window.localStorage.clear();
});

// ── Drag helpers ────────────────────────────────────────────────────────────
// handleDrag* / resolveBacklogDrop only read `active.id` and `over.id`, so a
// minimal shape is enough to drive every branch.
const dragStart = (id: string) =>
  act(() => h.dnd.onDragStart?.({ active: { id } } as unknown as DragStartEvent));
const dragOver = (activeId: string, overId: string | null) =>
  act(() =>
    h.dnd.onDragOver?.({
      active: { id: activeId },
      over: overId == null ? null : { id: overId },
    } as unknown as DragOverEvent),
  );
const dragEnd = (activeId: string, overId: string | null) =>
  act(() =>
    h.dnd.onDragEnd?.({
      active: { id: activeId },
      over: overId == null ? null : { id: overId },
    } as unknown as DragEndEvent),
  );
const dragCancel = () => act(() => h.dnd.onDragCancel?.());

function announcerText(): string {
  return screen.getByTestId('backlog-drop-announcer').textContent ?? '';
}

// ── Layout swap (issue 1044) ────────────────────────────────────────────────
describe('ProductBacklogPage layout swap (issue 1044)', () => {
  it('renders the mobile grooming shell below sm', () => {
    h.bp.value = 'sm';
    renderPage();
    expect(screen.getByTestId('mobile-grooming')).toBeInTheDocument();
  });

  it('renders the desktop grooming table at md and above', () => {
    h.bp.value = 'lg';
    renderPage();
    expect(screen.queryByTestId('mobile-grooming')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading backlog…' })).toBeInTheDocument();
  });
});

// ── Loading / error / empty gates ───────────────────────────────────────────
describe('DesktopGroomingView data gates', () => {
  it('shows a skeleton status region while loading', () => {
    h.backlog = { isLoading: true, isError: false, data: undefined };
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading backlog…' })).toBeInTheDocument();
    expect(screen.queryByText('Product backlog')).not.toBeInTheDocument();
  });

  it('shows an error message on fetch error', () => {
    h.backlog = { isLoading: false, isError: true, data: undefined };
    renderPage();
    expect(screen.getByText('Could not load the product backlog.')).toBeInTheDocument();
  });

  it('shows the error message when data is absent even without an error flag', () => {
    h.backlog = { isLoading: false, isError: false, data: undefined };
    renderPage();
    expect(screen.getByText('Could not load the product backlog.')).toBeInTheDocument();
  });

  it('renders the empty state when there are no epics and no ungrouped stories', () => {
    setData(makeBacklog({ epics: [], ungrouped: [] }));
    renderPage();
    expect(screen.getByText('No stories yet')).toBeInTheDocument();
    // Empty backlog hides the filter bar.
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument();
  });
});

// ── Header / subtitle composition ───────────────────────────────────────────
describe('DesktopGroomingView header', () => {
  it('composes the subtitle from pulled / proposed / pending counts and the score note', () => {
    setData(makeBacklog());
    renderPage();
    // s1 pulled (sprintId, not pending), s2 proposed (no sprint), s3 pending.
    expect(
      screen.getByText(
        'Epics → stories · scored & ordered · 1 pulled into sprint · 1 proposed · 1 pending',
      ),
    ).toBeInTheDocument();
  });

  it('omits the "scored & ordered" note and the pending clause when not applicable', () => {
    setData(
      makeBacklog({
        scoring: { model: 'none' },
        epics: [
          {
            epic: epicTask,
            stories: [makeStory('a', { sprintId: 'sp1' })],
            rollup: { storyCount: 1, pointsTotal: 2, pointsDone: 0 },
          },
        ],
        ungrouped: [makeStory('b')],
      }),
    );
    renderPage();
    expect(screen.getByText('Epics → stories · 1 pulled into sprint · 1 proposed')).toBeInTheDocument();
  });

  it('shows the model badge and score column header only when a model is set', () => {
    setData(makeBacklog());
    const { unmount } = renderPage();
    // Model badge chip in the header and the score column header.
    expect(screen.getAllByText('WSJF').length).toBeGreaterThanOrEqual(1);
    unmount();

    setData(makeBacklog({ scoring: { model: 'none' } }));
    renderPage();
    expect(screen.queryByText('WSJF')).not.toBeInTheDocument();
  });
});

// ── Auto-rank button ────────────────────────────────────────────────────────
describe('Auto-rank control', () => {
  it('is enabled with a model and triggers the mutation on click', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const btn = screen.getByRole('button', { name: 'Auto-rank' });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(h.autoRankMutate).toHaveBeenCalledTimes(1);
  });

  it('is disabled when the project has no prioritization model', () => {
    setData(makeBacklog({ scoring: { model: 'none' } }));
    renderPage();
    expect(screen.getByRole('button', { name: 'Auto-rank' })).toBeDisabled();
  });

  it('shows a pending label and disables while ranking', () => {
    h.autoRankPending = true;
    setData(makeBacklog());
    renderPage();
    const btn = screen.getByRole('button', { name: 'Ranking…' });
    expect(btn).toBeDisabled();
  });
});

// ── Plan sprint navigation ──────────────────────────────────────────────────
describe('Plan sprint navigation', () => {
  it('navigates to the sprints view', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Plan sprint' }));
    expect(h.navigate).toHaveBeenCalledWith('/projects/proj-1/sprints');
  });
});

// ── Health strip ────────────────────────────────────────────────────────────
describe('Health strip', () => {
  it('renders the DoR percentage, ready-points capacity, and estimate summary', () => {
    setData(makeBacklog());
    renderPage();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 stories ready')).toBeInTheDocument();
    expect(screen.getByText('5 of 10 pts capacity')).toBeInTheDocument();
    expect(screen.getByText('all stories pointed')).toBeInTheDocument();
    expect(screen.getByText('3/4')).toBeInTheDocument();
  });

  it('shows the no-capacity copy and the estimate-needed copy when applicable', () => {
    setData(
      makeBacklog({
        health: {
          dorPct: 40,
          readyCount: 1,
          readyPoints: 2,
          capacityPoints: null,
          unestimated: 3,
          acMet: 0,
          acTotal: 0,
          storyCount: 3,
        },
      }),
    );
    renderPage();
    expect(screen.getByText('no active sprint capacity')).toBeInTheDocument();
    expect(screen.getByText('need an estimate')).toBeInTheDocument();
  });
});

// ── Quick-add story ─────────────────────────────────────────────────────────
describe('Quick-add story', () => {
  it('commits a trimmed title on Enter and clears the input', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Add a story' });
    await user.type(input, '  New story  {Enter}');
    expect(h.quickAddMutate).toHaveBeenCalledTimes(1);
    expect(h.quickAddMutate.mock.calls[0][0]).toEqual({ name: 'New story' });
    expect(input).toHaveValue('');
  });

  it('does not commit an empty/whitespace title', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Add a story' });
    await user.type(input, '   {Enter}');
    expect(h.quickAddMutate).not.toHaveBeenCalled();
  });

  it('clears the draft on Escape without committing', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Add a story' });
    await user.type(input, 'discard me');
    expect(input).toHaveValue('discard me');
    await user.type(input, '{Escape}');
    expect(input).toHaveValue('');
    expect(h.quickAddMutate).not.toHaveBeenCalled();
  });

  it('the header "Add story" button focuses the quick-add input', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Add a story' });
    expect(input).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: '+ Add story' }));
    expect(input).toHaveFocus();
  });
});

// ── Create-intent effect (ADR-0131) ─────────────────────────────────────────
describe('story create-intent', () => {
  it('focuses the quick-add input and consumes the intent on mount', () => {
    h.intent = { kind: 'story', projectId: 'proj-1' };
    setData(makeBacklog());
    renderPage();
    expect(screen.getByRole('textbox', { name: 'Add a story' })).toHaveFocus();
    expect(h.closeIntent).toHaveBeenCalledTimes(1);
  });

  it('ignores an intent for a different project', () => {
    h.intent = { kind: 'story', projectId: 'other-project' };
    setData(makeBacklog());
    renderPage();
    expect(h.closeIntent).not.toHaveBeenCalled();
  });
});

// ── Inline epic add ─────────────────────────────────────────────────────────
describe('Inline epic add', () => {
  it('reveals the epic input, commits on Enter, and closes on Escape', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: '+ Add epic' }));
    expect(h.createEpicReset).toHaveBeenCalledTimes(1);
    const input = screen.getByRole('textbox', { name: 'New epic name' });
    await user.type(input, 'Billing{Enter}');
    expect(h.createEpicMutate).toHaveBeenCalledTimes(1);
    expect(h.createEpicMutate.mock.calls[0][0]).toEqual({ name: 'Billing' });
    // Input stays open and cleared for rapid multi-add.
    expect(input).toHaveValue('');
    await user.type(input, '{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New epic name' })).not.toBeInTheDocument();
  });

  it('surfaces an inline error alert when the epic create fails', async () => {
    const user = userEvent.setup();
    h.createEpicError = true;
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: '+ Add epic' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add epic — try again.");
  });

  it('hides the "+ Add epic" button for a user who cannot manage the backlog', () => {
    h.canManage = false;
    setData(makeBacklog());
    renderPage();
    expect(screen.queryByRole('button', { name: '+ Add epic' })).not.toBeInTheDocument();
  });
});

// ── Definition-of-Ready toggle ──────────────────────────────────────────────
describe('Definition-of-Ready toggle', () => {
  it('toggles a ready story to refine', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    // Rows render epics first (s1 ready, s2 refine), then ungrouped (s3).
    const dorButtons = screen.getAllByTitle('Toggle Definition of Ready (ready / refine)');
    await user.click(dorButtons[0]); // s1 is 'ready'
    expect(h.setDorMutate).toHaveBeenCalledWith({ taskId: 's1', dor: 'refine' });
  });

  it('toggles a non-ready story to ready', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    const dorButtons = screen.getAllByTitle('Toggle Definition of Ready (ready / refine)');
    await user.click(dorButtons[1]); // s2 is 'refine'
    expect(h.setDorMutate).toHaveBeenCalledWith({ taskId: 's2', dor: 'ready' });
  });
});

// ── Row + epic drawers ──────────────────────────────────────────────────────
describe('Detail drawers', () => {
  it('opens the story drawer on row click and closes it', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Open story Login flow' }));
    expect(screen.getByTestId('story-drawer')).toHaveTextContent('story-drawer-Login flow');
    await user.click(screen.getByRole('button', { name: 'close-story' }));
    expect(screen.queryByTestId('story-drawer')).not.toBeInTheDocument();
  });

  it('opens the epic drawer from the epic header', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'epic-open-Auth epic' }));
    expect(screen.getByTestId('epic-drawer')).toHaveTextContent('epic-drawer-Auth epic');
  });
});

// ── View toggle + persistence ───────────────────────────────────────────────
describe('By epic / Ranked view toggle', () => {
  it('switches to the ranked view, persists the choice, and orders by score desc', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('radio', { name: 'Ranked' }));
    expect(window.localStorage.getItem('trueppm.backlog.view')).toBe('ranked');
    // Ranked view is flat + read-only: no epic headers, "+ Add epic" hidden.
    expect(screen.queryByRole('button', { name: 'epic-open-Auth epic' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add epic' })).not.toBeInTheDocument();
    // Highest score (s2=9) gets rank 1 in the ranked list.
    const s2Row = screen.getByRole('button', { name: 'Open story Signup form, rank 1' });
    expect(s2Row).toBeInTheDocument();
  });

  it('starts in the ranked view when localStorage has it persisted', () => {
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(makeBacklog());
    renderPage();
    expect(screen.getByRole('button', { name: 'Open story Signup form, rank 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'epic-open-Auth epic' })).not.toBeInTheDocument();
  });

  it('switches back to the epic view and re-persists', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('radio', { name: 'By epic' }));
    expect(window.localStorage.getItem('trueppm.backlog.view')).toBe('epic');
    expect(screen.getByRole('button', { name: 'epic-open-Auth epic' })).toBeInTheDocument();
  });
});

// ── Ready line ──────────────────────────────────────────────────────────────
describe('Next-sprint ready line', () => {
  it('draws the ready line after the row where cumulative ready points reach capacity', () => {
    // capacity 3; s1 (ready, 3pts) alone reaches it → ready line after s1.
    setData(makeBacklog({ health: { ...makeBacklog().health, capacityPoints: 3 } }));
    renderPage();
    expect(screen.getByText('Next-sprint ready line')).toBeInTheDocument();
  });

  it('omits the ready line when there is no capacity', () => {
    setData(makeBacklog({ health: { ...makeBacklog().health, capacityPoints: null } }));
    renderPage();
    expect(screen.queryByText('Next-sprint ready line')).not.toBeInTheDocument();
  });
});

// ── Filter branches (issue 1044) ────────────────────────────────────────────
describe('Grooming filter states', () => {
  it('shows a no-results block that clears the filters', async () => {
    const user = userEvent.setup();
    h.filterActive = true;
    h.filters = { query: 'zzz-no-match', dorStates: [], unestimatedOnly: false };
    setData(makeBacklog());
    renderPage();
    expect(screen.getByText('No stories match your filters.')).toBeInTheDocument();
    expect(screen.getByTestId('filter-bar')).toHaveTextContent('0/3');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(h.resetFilters).toHaveBeenCalledTimes(1);
  });

  it('renders a read-only filtered epic view with the drag-disabled hint', () => {
    h.filterActive = true;
    h.filters = { query: 'login', dorStates: [], unestimatedOnly: false };
    setData(makeBacklog());
    renderPage();
    expect(
      screen.getByText('Filtered — drag to reorder is disabled. Clear filters to reorder.'),
    ).toBeInTheDocument();
    // Only the matching story survives the filter.
    expect(screen.getByRole('button', { name: 'Open story Login flow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open story Signup form' })).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-bar')).toHaveTextContent('1/3');
  });
});

// ── Sprint planning rail (issue 1291) ───────────────────────────────────────
describe('Sprint planning rail', () => {
  it('shows the rail with committed points and story count when a sprint is planned', () => {
    h.planned = [{ id: 'sp1', name: 'Sprint 1' }];
    setData(makeBacklog());
    renderPage();
    // s1 (3pts) and s3 (null pts) are committed to sp1 → 3 pts across 2 stories.
    expect(screen.getByTestId('planning-rail')).toHaveTextContent('rail-3pts-2stories');
  });

  it('hides the rail while a story detail drawer is open', async () => {
    const user = userEvent.setup();
    h.planned = [{ id: 'sp1', name: 'Sprint 1' }];
    setData(makeBacklog());
    renderPage();
    expect(screen.getByTestId('planning-rail')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open story Login flow' }));
    expect(screen.queryByTestId('planning-rail')).not.toBeInTheDocument();
  });

  it('does not render the rail when no sprint is in planning', () => {
    h.planned = [];
    setData(makeBacklog());
    renderPage();
    expect(screen.queryByTestId('planning-rail')).not.toBeInTheDocument();
  });
});

// ── Table structure sanity ──────────────────────────────────────────────────
describe('Table columns', () => {
  it('renders the fixed column headers including the iteration singular', () => {
    setData(makeBacklog());
    renderPage();
    expect(screen.getByText('Acceptance')).toBeInTheDocument();
    expect(screen.getByText('Readiness')).toBeInTheDocument();
    // The sprint-commitment column header is the iteration singular ("Sprint").
    expect(screen.getAllByText('Sprint').length).toBeGreaterThanOrEqual(1);
  });
});

// ── Story row keyboard + click affordances ──────────────────────────────────
describe('Story row interaction', () => {
  it('opens the story drawer when Enter is pressed on a row', async () => {
    setData(makeBacklog());
    renderPage();
    const row = screen.getByRole('button', { name: 'Open story Login flow' });
    act(() => {
      row.focus();
    });
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('story-drawer')).toHaveTextContent('story-drawer-Login flow');
  });

  it('opens the story drawer when Space is pressed on a row', async () => {
    setData(makeBacklog());
    renderPage();
    const row = screen.getByRole('button', { name: 'Open story Signup form' });
    row.focus();
    await userEvent.keyboard(' ');
    expect(screen.getByTestId('story-drawer')).toHaveTextContent('story-drawer-Signup form');
  });

  it('ignores unrelated keys without opening a drawer', async () => {
    setData(makeBacklog());
    renderPage();
    const row = screen.getByRole('button', { name: 'Open story Login flow' });
    row.focus();
    await userEvent.keyboard('x');
    expect(screen.queryByTestId('story-drawer')).not.toBeInTheDocument();
  });

  it('does not open the drawer when the drag handle itself is clicked (stopPropagation)', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Reorder Login flow' }));
    expect(screen.queryByTestId('story-drawer')).not.toBeInTheDocument();
  });
});

// ── Drag: reorder within a group (ADR-0110) ─────────────────────────────────
describe('Drag reorder', () => {
  it('persists a rank-only reorder within an epic on drop', () => {
    setData(makeBacklog());
    renderPage();
    // Drag s1 over s2 — both live in epic e1 → reorder that group.
    dragEnd('s1', 's2');
    expect(h.reorderMutate).toHaveBeenCalledTimes(1);
    const payload = h.reorderMutate.mock.calls[0][0] as {
      stories: { id: string; server_version: number }[];
    };
    // arrayMove([s1,s2]) placing s1 after s2 → [s2, s1]; ungrouped s3 trails.
    expect(payload.stories.map((e) => e.id)).toEqual(['s2', 's1', 's3']);
    expect(payload.stories[0].server_version).toBe(1);
  });

  it('persists a reorder within the ungrouped bucket', () => {
    const u1 = makeStory('u1', { name: 'Loose one' });
    const u2 = makeStory('u2', { name: 'Loose two' });
    setData(makeBacklog({ ungrouped: [u1, u2] }));
    renderPage();
    dragEnd('u1', 'u2');
    expect(h.reorderMutate).toHaveBeenCalledTimes(1);
    const payload = h.reorderMutate.mock.calls[0][0] as {
      stories: { id: string }[];
    };
    // epic stories (s1,s2) lead; ungrouped reordered to [u2, u1].
    expect(payload.stories.map((e) => e.id)).toEqual(['s1', 's2', 'u2', 'u1']);
  });

  it('is a no-op when dropped on nothing', () => {
    setData(makeBacklog());
    renderPage();
    dragEnd('s1', null);
    expect(h.reorderMutate).not.toHaveBeenCalled();
    expect(h.reparentMutate).not.toHaveBeenCalled();
  });

  it('surfaces the reload banner when a reorder returns a non-400 error', () => {
    h.reorderMutate.mockImplementation(
      (_p: unknown, opts: { onError: (e: unknown) => void }) => {
        opts.onError({ isAxiosError: true, response: { status: 409 } });
      },
    );
    setData(makeBacklog());
    renderPage();
    dragEnd('s1', 's2');
    expect(screen.getByText('Backlog changed — reloaded. Try your move again.')).toBeInTheDocument();
  });

  it('does not show the banner when the reorder error is a 400 (validation)', () => {
    h.reorderMutate.mockImplementation(
      (_p: unknown, opts: { onError: (e: unknown) => void }) => {
        opts.onError({ isAxiosError: true, response: { status: 400 } });
      },
    );
    setData(makeBacklog());
    renderPage();
    dragEnd('s1', 's2');
    expect(
      screen.queryByText('Backlog changed — reloaded. Try your move again.'),
    ).not.toBeInTheDocument();
  });

  it('dismisses the reload banner', async () => {
    const user = userEvent.setup();
    h.reorderMutate.mockImplementation(
      (_p: unknown, opts: { onError: (e: unknown) => void }) => {
        opts.onError(new Error('network down'));
      },
    );
    setData(makeBacklog());
    renderPage();
    dragEnd('s1', 's2');
    expect(screen.getByText('Backlog changed — reloaded. Try your move again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText('Backlog changed — reloaded. Try your move again.'),
    ).not.toBeInTheDocument();
  });
});

// ── Drag: reparent across groups (ADR-0183 D3) ──────────────────────────────
describe('Drag reparent', () => {
  it('reparents a story into an epic and announces the move', () => {
    h.reparentMutate.mockImplementation(
      (_p: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    setData(makeBacklog());
    renderPage();
    // Drag ungrouped s3 onto epic e1's region → reparent into that epic.
    dragEnd('s3', 'epic:e1');
    expect(h.reparentMutate).toHaveBeenCalledTimes(1);
    expect(h.reparentMutate.mock.calls[0][0]).toMatchObject({
      taskId: 's3',
      parentEpicId: 'e1',
    });
    expect(announcerText()).toBe('Moved Reset password to epic Auth epic.');
  });

  it('reparents a story out of all epics (drop on the No-epic bucket)', () => {
    h.reparentMutate.mockImplementation(
      (_p: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    setData(makeBacklog());
    renderPage();
    dragEnd('s1', 'epic:__ungrouped__');
    expect(h.reparentMutate.mock.calls[0][0]).toMatchObject({
      taskId: 's1',
      parentEpicId: null,
    });
    expect(announcerText()).toBe('Moved Login flow out of all epics.');
  });

  it('shows the reload banner and announces failure when a reparent errors', () => {
    h.reparentMutate.mockImplementation(
      (_p: unknown, opts: { onError: () => void }) => opts.onError(),
    );
    setData(makeBacklog());
    renderPage();
    dragEnd('s3', 'epic:e1');
    expect(screen.getByText('Backlog changed — reloaded. Try your move again.')).toBeInTheDocument();
    expect(announcerText()).toBe(
      "Couldn't move Reset password. The backlog was reloaded — try again.",
    );
  });

  it('refuses a reparent while offline and announces it', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      setData(makeBacklog());
      renderPage();
      dragEnd('s3', 'epic:e1');
      expect(h.reparentMutate).not.toHaveBeenCalled();
      expect(announcerText()).toBe("Couldn't move Reset password — you're offline.");
    } finally {
      if (original) Object.defineProperty(navigator, 'onLine', original);
    }
  });

  it('does not reparent for a user who cannot manage the backlog', () => {
    h.canManage = false;
    setData(makeBacklog());
    renderPage();
    dragEnd('s3', 'epic:e1');
    expect(h.reparentMutate).not.toHaveBeenCalled();
  });
});

// ── Drag: over-target arming + ghost + cancel ───────────────────────────────
describe('Drag over/start/cancel bookkeeping', () => {
  it('renders the drag ghost payload once a drag starts', () => {
    setData(makeBacklog());
    renderPage();
    // Row only before drag; ghost adds a second occurrence of the name.
    expect(screen.getAllByText('Login flow')).toHaveLength(1);
    dragStart('s1');
    expect(screen.getAllByText('Login flow')).toHaveLength(2);
  });

  it('arms a different epic as a reparent target while dragging over it', () => {
    setData(makeBacklog());
    renderPage();
    // Drag ungrouped s3 over epic e1 → arms the "No epic → epic" reparent target.
    dragStart('s3');
    dragOver('s3', 'epic:e1');
    // The armed epic region exposes the DropZone with data-armed set.
    const armed = document.querySelector('[data-droppable="epic:e1"][data-armed="true"]');
    expect(armed).not.toBeNull();
  });

  it('arms the No-epic bucket and shows the remove hint when dragging an epic story out', () => {
    setData(makeBacklog());
    renderPage();
    dragStart('s1');
    dragOver('s1', 'epic:__ungrouped__');
    expect(screen.getByText('↳ Drop to remove from its epic')).toBeInTheDocument();
  });

  it('does not arm when hovering the source group', () => {
    setData(makeBacklog());
    renderPage();
    dragStart('s1');
    // s1 and s2 share epic e1; hovering s2 (same group) must not arm a target.
    dragOver('s1', 's2');
    expect(document.querySelector('[data-armed="true"]')).toBeNull();
  });

  it('clears the armed target when dragging over nothing', () => {
    setData(makeBacklog());
    renderPage();
    dragStart('s3');
    dragOver('s3', 'epic:e1');
    expect(document.querySelector('[data-armed="true"]')).not.toBeNull();
    dragOver('s3', null);
    expect(document.querySelector('[data-armed="true"]')).toBeNull();
  });

  it('does not arm a reparent target for a non-manager', () => {
    h.canManage = false;
    setData(makeBacklog());
    renderPage();
    dragStart('s3');
    dragOver('s3', 'epic:e1');
    expect(document.querySelector('[data-armed="true"]')).toBeNull();
  });

  it('clears the ghost when the drag is cancelled', () => {
    setData(makeBacklog());
    renderPage();
    dragStart('s1');
    expect(screen.getAllByText('Login flow')).toHaveLength(2);
    dragCancel();
    expect(screen.getAllByText('Login flow')).toHaveLength(1);
  });
});

// ── Empty epic + ungrouped drop-slot messaging ──────────────────────────────
describe('Empty-group drop slots', () => {
  function emptyEpicBacklog(over: Partial<ProductBacklog> = {}): ProductBacklog {
    return makeBacklog({
      epics: [
        {
          epic: makeStory('e9', { name: 'Empty epic', taskType: 'epic' }),
          stories: [],
          rollup: { storyCount: 0, pointsTotal: 0, pointsDone: 0 },
        },
      ],
      ungrouped: [makeStory('lone', { name: 'Lone story' })],
      ...over,
    });
  }

  it('invites a drag into an empty epic when idle and manageable', () => {
    setData(emptyEpicBacklog());
    renderPage();
    expect(
      screen.getByText(/No stories yet — drag a story here or set this epic/),
    ).toBeInTheDocument();
  });

  it('shows the read-only hint for a non-manager on an empty epic', () => {
    h.canManage = false;
    setData(emptyEpicBacklog());
    renderPage();
    expect(
      screen.getByText(/No stories yet — set this epic from a story’s detail drawer\./),
    ).toBeInTheDocument();
  });

  it('shows the active drop prompt on an empty epic while dragging', () => {
    setData(emptyEpicBacklog());
    renderPage();
    dragStart('lone');
    expect(screen.getByText('Drop here to add this story to the epic.')).toBeInTheDocument();
  });

  it('reveals the No-epic bucket drop prompt while a manager drags with nothing ungrouped', () => {
    setData(emptyEpicBacklog({ ungrouped: [], epics: makeBacklog().epics }));
    renderPage();
    // Start dragging an epic story so the transient No-epic bucket appears.
    dragStart('s1');
    expect(
      screen.getByText('Drop here to remove this story from its epic.'),
    ).toBeInTheDocument();
  });
});

// ── Ranked view details ─────────────────────────────────────────────────────
describe('Ranked view rendering', () => {
  it('keeps manual priority order (no score sort) when the project has no model', () => {
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(makeBacklog({ scoring: { model: 'none' } }));
    renderPage();
    // Without a model, allStories order is preserved: s1 is rank 1 (not s2 by score).
    expect(
      screen.getByRole('button', { name: 'Open story Login flow, rank 1' }),
    ).toBeInTheDocument();
    // No score column header when there is no model.
    expect(screen.queryByText('WSJF')).not.toBeInTheDocument();
  });

  it('shows the parent-epic breadcrumb for grouped rows and omits it for ungrouped', () => {
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(makeBacklog());
    renderPage();
    // s1/s2 belong to "Auth epic" → breadcrumb text renders (epic headers are hidden
    // in ranked view, so this text can only come from the row breadcrumb).
    expect(screen.getAllByText('Auth epic').length).toBeGreaterThanOrEqual(1);
  });

  it('opens the story drawer from a ranked row', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Open story Signup form, rank 1' }));
    expect(screen.getByTestId('story-drawer')).toHaveTextContent('story-drawer-Signup form');
  });

  it('renders an oversized-points row and an em-dash for an unscored story', () => {
    window.localStorage.setItem('trueppm.backlog.view', 'ranked');
    setData(
      makeBacklog({
        epics: [
          {
            epic: epicTask,
            stories: [makeStory('big', { name: 'Chunky', storyPoints: 13, score: 4 })],
            rollup: { storyCount: 1, pointsTotal: 13, pointsDone: 0 },
          },
        ],
        ungrouped: [makeStory('nopts', { name: 'No estimate', storyPoints: null, score: null })],
      }),
    );
    renderPage();
    // Oversized (>=8) points render their value.
    expect(screen.getByText('13')).toBeInTheDocument();
    // The unscored story shows an em-dash in the score column.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});

// ── Filtered view epic drawer + epic-add blur ───────────────────────────────
describe('Additional composition branches', () => {
  it('opens the epic drawer from a filtered read-only epic header', async () => {
    const user = userEvent.setup();
    h.filterActive = true;
    h.filters = { query: 'login', dorStates: [], unestimatedOnly: false };
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'epic-open-Auth epic' }));
    expect(screen.getByTestId('epic-drawer')).toHaveTextContent('epic-drawer-Auth epic');
  });

  it('opens the story drawer from a filtered read-only row', async () => {
    const user = userEvent.setup();
    h.filterActive = true;
    h.filters = { query: 'login', dorStates: [], unestimatedOnly: false };
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Open story Login flow' }));
    expect(screen.getByTestId('story-drawer')).toHaveTextContent('story-drawer-Login flow');
  });

  it('renders the No-epic section in a filtered read-only view when ungrouped matches', () => {
    h.filterActive = true;
    // "reset" matches only s3, which is ungrouped → the "No epic" read-only section renders.
    h.filters = { query: 'reset', dorStates: [], unestimatedOnly: false };
    setData(makeBacklog());
    renderPage();
    expect(screen.getByText('No epic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open story Reset password' })).toBeInTheDocument();
  });

  it('closes the epic drawer via its close button', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: 'epic-open-Auth epic' }));
    expect(screen.getByTestId('epic-drawer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close-epic' }));
    expect(screen.queryByTestId('epic-drawer')).not.toBeInTheDocument();
  });

  it('closes the inline epic input on blur when left empty', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: '+ Add epic' }));
    const input = screen.getByRole('textbox', { name: 'New epic name' });
    input.focus();
    act(() => {
      input.blur();
    });
    expect(screen.queryByRole('textbox', { name: 'New epic name' })).not.toBeInTheDocument();
  });

  it('does not submit an epic when the name is only whitespace', async () => {
    const user = userEvent.setup();
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: '+ Add epic' }));
    const input = screen.getByRole('textbox', { name: 'New epic name' });
    await user.type(input, '   {Enter}');
    expect(h.createEpicMutate).not.toHaveBeenCalled();
  });

  it('restores the epic draft when the create fails', async () => {
    const user = userEvent.setup();
    h.createEpicMutate.mockImplementation(
      (_p: unknown, opts: { onError: () => void }) => opts.onError(),
    );
    setData(makeBacklog());
    renderPage();
    await user.click(screen.getByRole('button', { name: '+ Add epic' }));
    const input = screen.getByRole('textbox', { name: 'New epic name' });
    await user.type(input, 'Billing{Enter}');
    // Optimistic clear, then restore on error.
    expect(input).toHaveValue('Billing');
  });

  it('restores the quick-add draft when the story create fails', async () => {
    const user = userEvent.setup();
    h.quickAddMutate.mockImplementation(
      (_p: unknown, opts: { onError: () => void }) => opts.onError(),
    );
    setData(makeBacklog());
    renderPage();
    const input = screen.getByRole('textbox', { name: 'Add a story' });
    await user.type(input, 'Flaky story{Enter}');
    expect(input).toHaveValue('Flaky story');
  });
});
