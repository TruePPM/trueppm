/**
 * The `@owner` inline authoring token in the build-mode Name cell (ADR-0774, #2718).
 *
 * These assertions guard one property above all: the token must reach the API as an
 * `owners` array (which becomes a `TaskResource` row with units), and never as a bare
 * `Task.assignee`. Every capacity, utilization, heat-map and sprint-capacity number sums
 * `TaskResource.units` and never reads `assignee`, so the "obvious" implementation would
 * assign work that contributes zero load, silently and permanently.
 *
 * The mutation hook is mocked so the PATCH body is directly observable — that body IS
 * the contract this issue exists to pin down.
 */
import { useMemo } from 'react';
import { screen, render, fireEvent, act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ProjectResource, Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const mocks = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: null, roleLabel: null, isLoading: false }),
}));

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useUpdateTask: () =>
      ({ mutate: mocks.updateMutate, mutateAsync: mocks.updateMutateAsync }) as never,
    useReorderTasks: () => ({ mutate: vi.fn() }) as never,
    useToggleComplete: () => ({ mutate: vi.fn() }) as never,
    useDuplicateTask: () => ({ mutate: vi.fn() }) as never,
  };
});

// The Name cell opens the sprint prompt on commit; stub it so this suite does not stand
// up the real picker's fetches.
vi.mock('./buildMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./buildMode')>();
  return { ...actual, SprintPrompt: () => null };
});

const { TaskListRow } = await import('./TaskListRow');
const { BuildModeProvider } = await import('./buildMode/BuildModeContext');
const { useScheduleFocus } = await import('./buildMode');
type BuildModeApi = import('./buildMode').BuildModeApi;
type FocusApi = import('./buildMode').UseScheduleFocusReturn;

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const base: Task = {
  id: 't1', wbs: '1.2', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

function member(id: string, name: string, roleTitle = ''): ProjectResource {
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: id,
    resource: {
      id, name, email: `${id}@example.com`, jobRole: '',
      maxUnits: 1, calendarId: null, skills: [],
    },
    roleTitle,
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  } as ProjectResource;
}

const POOL = [member('r-ana', 'Ana Rivera', 'Analyst'), member('r-ben', 'Ben Okafor')];

interface HarnessProps {
  task?: Task;
  resourcePool?: ProjectResource[];
  nameSuggestions?: string[];
  focusRef: { current: FocusApi | null };
}

function Harness({ task = base, resourcePool, nameSuggestions, focusRef }: HarnessProps) {
  const focus = useScheduleFocus();
  focusRef.current = focus;
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: vi.fn(),
      outdent: vi.fn(),
      insertBelow: vi.fn(),
      convertToMilestone: vi.fn(),
      deleteTask: vi.fn(),
      isMutationPending: () => false,
    }),
    [focus],
  );
  return (
    <BuildModeProvider api={api}>
      <TaskListRow
        task={task}
        level={2}
        widths={widths}
        visible={visible}
        resourcePool={resourcePool}
        nameSuggestions={nameSuggestions}
      />
    </BuildModeProvider>
  );
}

function renderBuild(props: Omit<HarnessProps, 'focusRef'> = {}) {
  const focusRef: { current: FocusApi | null } = { current: null };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="/projects/:projectId/schedule"
            element={<Harness {...props} focusRef={focusRef} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { focus: () => focusRef.current as FocusApi };
}

function startEditing(focus: () => FocusApi) {
  act(() => {
    focus().focusRow('t1');
    focus().enterCellEdit('t1', 'name');
  });
  return screen.getByLabelText('Rename task Design Phase');
}

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.setState({
    selectedTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
  });
});

describe('@owner token — commit', () => {
  it('sends owners (TaskResource), never assignee, and strips the token from the name', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft migration plan @ana{Enter}');

    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Draft migration plan',
      owners: [{ resource: 'r-ana', units: 1 }],
    });
    const [payload] = mocks.updateMutate.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty('assignee');
  });

  it('@ana:50 commits a half allocation as the API fraction 0.5', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Review @ana:50{Enter}');

    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Review', owners: [{ resource: 'r-ana', units: 0.5 }] }),
    );
  });

  it('leaves an unmatched name in the committed text and sends no owners', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft plan @nobody{Enter}');

    // The row still commits — dropping it to punish a typo is the worse failure.
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Draft plan @nobody',
    });
    expect(mocks.updateMutate.mock.calls[0][0]).not.toHaveProperty('owners');
  });

  it('sends no owners key at all when the name carries no token', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Discovery{Enter}');

    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Discovery',
    });
  });

  it('does not resolve tokens when no roster is available', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft @ana{Enter}');

    // Without the roster there is no membership index to resolve against, so the text
    // is committed verbatim rather than guessed at.
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Draft @ana',
    });
  });
});

describe('@owner token — picker', () => {
  it('opens the roster listbox while the caret is inside an @ fragment', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft @an');

    const listbox = await screen.findByRole('listbox', { name: 'Assign owner' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Ana Rivera/ })).toBeInTheDocument();
  });

  it('picking a person completes the token in place, then commit PATCHes owners', async () => {
    // Since #2722 a pick REWRITES the draft rather than committing the row: focus
    // never leaves the row and more tokens may follow, so completing `@an` must not
    // end the edit.
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft plan @an');

    fireEvent.mouseDown(await screen.findByRole('option', { name: /Ana Rivera/ }));
    await waitFor(() => expect(input).toHaveValue('Draft plan @"Ana Rivera"'));
    expect(mocks.updateMutate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't1',
        projectId: 'p1',
        name: 'Draft plan',
        owners: [{ resource: 'r-ana', units: 1 }],
      }),
    );
  });

  it('honors a percent already typed before the pick', async () => {
    // Picking from the list must not silently reset an allocation the author already
    // typed — the completed token keeps the `:25` suffix (ADR-0774).
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Draft @ana:25');

    fireEvent.mouseDown(await screen.findByRole('option', { name: /Ana Rivera/ }));
    await waitFor(() => expect(input).toHaveValue('Draft @"Ana Rivera":25'));

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ owners: [{ resource: 'r-ana', units: 0.25 }] }),
    );
  });

  it('suppresses the name-suggestion popover while the owner picker is open', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({
      resourcePool: POOL,
      nameSuggestions: ['Design Review', 'Deploy'],
    });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Des');
    expect(await screen.findByRole('option', { name: 'Design Review' })).toBeInTheDocument();

    // Two listboxes in one cell would fight over the same Arrow/Enter keys.
    await user.type(input, ' @an');
    expect(await screen.findByRole('listbox', { name: 'Assign owner' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Design Review' })).not.toBeInTheDocument();
  });

  it('does not open on an @ inside a word, so an email address is just text', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ resourcePool: POOL });
    const input = startEditing(focus);
    await user.clear(input);
    await user.type(input, 'Email ana@example');
    expect(screen.queryByRole('listbox', { name: 'Assign owner' })).not.toBeInTheDocument();
  });
});
