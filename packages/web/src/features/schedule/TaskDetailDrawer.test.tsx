import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';

import type { Task } from '@/types';
import { registry, type DrawerSectionContext } from '@/lib/widget-registry';
import { TaskDetailDrawer, SectionList } from './TaskDetailDrawer';
import { useReportComposerDirty } from './ComposerDirtyContext';

// `delay: null` dispatches keystrokes with no inter-event setTimeout so the
// whole `user.type()` resolves within one flush. With the default delay, the
// last keystroke's React 19 state commit can race the following synchronous
// assert/rerender on a CPU-loaded CI runner and the trailing character is
// silently dropped — the "web:test 6/6" flake (#2084). Assertions that snapshot
// the typed value additionally settle with `waitFor` before reading it.

// Capture the mutation call args so we can assert the drawer opts into ADR-0217
// field-level merge by declaring baseVersion (#2038).
type SavePayload = {
  id: string;
  projectId: string;
  baseVersion?: number;
  name?: string;
};
const mutate = vi.fn<(payload: SavePayload, opts?: { onSuccess?: () => void }) => void>();
// Mutable mutation state so individual tests can flip the in-flight / failed
// branches (the save-bar spinner and the "Couldn't save" alert). `mock`-prefixed
// so the vi.mock factory may close over them.
let mockIsSaving = false;
let mockIsError = false;
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: mockIsSaving, isError: mockIsError }),
}));

// Spy on navigation so the Expand → full-page path is assertable while keeping
// the real MemoryRouter (imported below) for the surrounding route context.
const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

let TASKS: Partial<Task>[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS, isLoading: false }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  // Scheduler (3) can edit — canEditTask(userRole) is true.
  useCurrentUserRole: () => ({ role: 3 }),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ singular: 'Sprint', plural: 'Sprints' }),
}));
// Keep the render a unit: no registered sections, stub the two heavy children.
vi.mock('./sections', () => ({ registerOssDrawerSections: () => {} }));
vi.mock('./TaskScheduleStrip', () => ({ TaskScheduleStrip: () => <div /> }));
vi.mock('./TaskDescriptionField', () => ({ TaskDescriptionField: () => <div /> }));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Foundation',
    projectId: 'p1',
    serverVersion: 7,
    canEdit: true,
    ...overrides,
  } as Task;
}

function renderDrawer(task: Task) {
  return render(
    <MemoryRouter>
      <TaskDetailDrawer task={task} projectId="p1" onClose={() => {}} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  TASKS = [];
  mockIsSaving = false;
  mockIsError = false;
  vi.clearAllMocks();
});

// Register drawer sections into the real registry singleton, gated so they only
// surface for tasks whose id is 'tabtest' — this keeps the Subtasks/Activity
// tabs (and their badges) exercisable without leaking into the other suites
// (which all use id 't1'/'t2', for which canRender returns false).
beforeAll(() => {
  const onlyTabTest = (ctx: unknown): boolean =>
    (ctx as DrawerSectionContext).task != null &&
    ((ctx as DrawerSectionContext).task as Task).id === 'tabtest';
  registry.register('task_detail.section', {
    id: 'test-subtasks',
    priority: 10,
    title: 'Subtasks',
    tab: 'subtasks',
    component: () => <div>subtasks-panel-body</div>,
    canRender: onlyTabTest,
  });
  registry.register('task_detail.section', {
    id: 'test-activity',
    priority: 20,
    title: 'Activity',
    tab: 'activity',
    component: () => <div>activity-panel-body</div>,
    canRender: onlyTabTest,
  });
  // A composer stand-in (#2153): reports unstaged text via ComposerDirtyContext,
  // exactly as CommentComposer / NotesComposer do, so the drawer's guard wiring
  // can be exercised without mounting the full composer + its hooks. Scoped to
  // task id 'composertest'.
  registry.register('task_detail.section', {
    id: 'test-composer',
    priority: 5,
    title: 'Discussion',
    tab: 'details',
    component: () => <ComposerProbe />,
    canRender: (ctx: unknown) =>
      (ctx as DrawerSectionContext).task != null &&
      ((ctx as DrawerSectionContext).task as Task).id === 'composertest',
  });
});

function ComposerProbe() {
  const [text, setText] = useState('');
  useReportComposerDirty(text.trim().length > 0);
  return (
    <button type="button" onClick={() => setText('a half-written comment')}>
      type-comment
    </button>
  );
}

describe('TaskDetailDrawer save concurrency (#2038)', () => {
  it('passes baseVersion from the task serverVersion when saving a name edit', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ serverVersion: 7 });
    TASKS = [task];
    renderDrawer(task);

    // The drawer renders content in both a desktop and a mobile container (both
    // present in the DOM, CSS-hidden); scope to the desktop dialog.
    const dialog = within(screen.getAllByRole('dialog')[0]);
    const name = dialog.getByLabelText('Task name');
    await user.clear(name);
    await user.type(name, 'Foundation reworked');

    await user.click(dialog.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [payload] = mutate.mock.calls[0];
    expect(payload).toMatchObject({
      id: 't1',
      projectId: 'p1',
      baseVersion: 7,
      name: 'Foundation reworked',
    });
  });

  it('carries baseVersion even when serverVersion is undefined (legacy rows)', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ serverVersion: undefined });
    TASKS = [task];
    renderDrawer(task);

    const dialog = within(screen.getAllByRole('dialog')[0]);
    const name = dialog.getByLabelText('Task name');
    await user.type(name, ' edit');
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [payload] = mutate.mock.calls[0];
    // baseVersion is explicitly present (undefined) — useUpdateTask treats a
    // missing header as legacy LWW, so this preserves prior behavior for
    // pre-version rows while enabling merge for versioned ones.
    expect('baseVersion' in payload).toBe(true);
    expect(payload.baseVersion).toBeUndefined();
  });
});

describe('TaskDetailDrawer deleted-while-dirty guard (#2054)', () => {
  const bannerText = /deleted by someone else/i;

  it('keeps a dirty draft on screen with a rescue banner when the task is deleted', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    const dialog = within(screen.getAllByRole('dialog')[0]);
    await user.type(dialog.getByLabelText('Task name'), ' reworked'); // draft is now dirty
    // Let the draft fully commit before the delete rerender snapshots it.
    await waitFor(() =>
      expect(dialog.getByLabelText('Task name')).toHaveValue('Foundation reworked'),
    );

    // Someone else deletes t1: it drops from the cache and the host prop goes null.
    TASKS = [sibling];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    // Two shells (desktop + mobile bottom-sheet) each render the banner.
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(bannerText);
    // The edited value is still on screen — nothing was discarded.
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Foundation reworked');
    // The (now futile) Save bar is suppressed in favor of the banner actions.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy my text' })[0]).toBeInTheDocument();
  });

  it('closes silently (no banner) when a clean drawer loses its task', () => {
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    // No edits → not dirty. Deleting the task should just close, no rescue banner.
    TASKS = [sibling];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not fire the banner on a deliberate deselect (task still exists)', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    await user.type(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'), ' x');

    // Prop goes null but the task is STILL in the cache — a deselect, not a
    // delete. (In production the unsaved-changes guard has already reset the
    // draft on this path; the cache-presence check is the belt-and-suspenders.)
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('copies the dirty draft to the clipboard from the banner', async () => {
    // userEvent.setup() installs a functional clipboard stub; let the component
    // write through it and assert on what landed there.
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    await user.clear(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'));
    await user.type(
      within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'),
      'Rescue me',
    );
    // Let the draft fully commit before the delete rerender snapshots it.
    await waitFor(() =>
      expect(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name')).toHaveValue(
        'Rescue me',
      ),
    );

    TASKS = [sibling];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    await screen.findAllByRole('alert');
    await user.click(screen.getAllByRole('button', { name: 'Copy my text' })[0]);
    expect(await navigator.clipboard.readText()).toContain('Rescue me');
  });

  it('copies notes and estimates into the rescued text, not just the name', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({
      id: 't1',
      name: 'Foundation',
      notes: 'pour the slab',
      optimisticDuration: 2,
      mostLikelyDuration: 4,
      pessimisticDuration: 6,
    } as Partial<Task>);
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    // Dirty the draft (name) so the delete path arms the rescue banner.
    await user.type(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'), '!');
    await waitFor(() =>
      expect(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name')).toHaveValue(
        'Foundation!',
      ),
    );

    TASKS = [sibling];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    await screen.findAllByRole('alert');
    await user.click(screen.getAllByRole('button', { name: 'Copy my text' })[0]);
    const copied = await navigator.clipboard.readText();
    // The seeded notes and the full estimate triple all round-trip into the rescue text.
    expect(copied).toContain('pour the slab');
    expect(copied).toContain('Optimistic: 2');
    expect(copied).toContain('Most likely: 4');
    expect(copied).toContain('Pessimistic: 6');
    // Button flips to the "Copied" confirmation after a successful write.
    expect(screen.getAllByRole('button', { name: 'Copied' })[0]).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Extended coverage (#2235): chips / permission gate, save-bar branches,
// close & expand guards, swap-while-dirty verbs, tab visibility + keyboard,
// and the exported SectionList.
// ---------------------------------------------------------------------------

interface DrawerHarness {
  onClose: ReturnType<typeof vi.fn>;
  onSwapCanceled: ReturnType<typeof vi.fn>;
  rerenderTask: (t: Task | null) => void;
}

function renderDrawerHarness(task: Task | null): DrawerHarness {
  const onClose = vi.fn();
  const onSwapCanceled = vi.fn();
  const ui = (t: Task | null) => (
    <MemoryRouter>
      <TaskDetailDrawer
        task={t}
        projectId="p1"
        onClose={onClose}
        onSwapCanceled={onSwapCanceled}
      />
    </MemoryRouter>
  );
  const { rerender } = render(ui(task));
  return { onClose, onSwapCanceled, rerenderTask: (t) => rerender(ui(t)) };
}

function desktop() {
  return within(screen.getAllByRole('dialog')[0]);
}

describe('TaskDetailDrawer header chips and permission gate', () => {
  it('renders the WBS, critical-path chip and the WBS-prefixed dialog title', () => {
    const task = makeTask({ wbs: '1.2', isCritical: true });
    TASKS = [task];
    renderDrawer(task);

    expect(screen.getAllByRole('dialog')[0]).toHaveAttribute('aria-label', '1.2 — Foundation');
    expect(desktop().getByText('1.2')).toBeInTheDocument();
    expect(desktop().getByText('CP')).toBeInTheDocument();
    // No "View only" chip for an editable task.
    expect(desktop().queryByText('View only')).not.toBeInTheDocument();
  });

  it('shows the View-only chip and a read-only name for a non-editable task', () => {
    const task = makeTask({ canEdit: false, isCritical: false });
    TASKS = [task];
    renderDrawer(task);

    expect(desktop().getByText('View only')).toBeInTheDocument();
    expect(desktop().getByLabelText('Task name')).toHaveAttribute('readonly');
    // Not on the critical path → no CP chip (the false branch).
    expect(desktop().queryByText('CP')).not.toBeInTheDocument();
  });

  it('shows the Esc-to-close hint (not the save bar) while clean', () => {
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    expect(desktop().getByText(/to close/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('TaskDetailDrawer save bar branches', () => {
  it('raises the save bar naming the changed field once the name is edited', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' X');
    expect(desktop().getByRole('button', { name: 'Save' })).toBeEnabled();
    // The polite status region names the changed scope.
    expect(screen.getAllByText('Unsaved changes: Name')[0]).toBeInTheDocument();
  });

  it('re-snapshots the baseline on save success so the bar clears', async () => {
    const user = userEvent.setup({ delay: null });
    mutate.mockImplementation((_payload, opts) => opts?.onSuccess?.());
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' done');
    await user.click(desktop().getByRole('button', { name: 'Save' }));

    // Baseline re-committed → no longer dirty → bar gives way to the Esc hint.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument(),
    );
    expect(desktop().getByText(/to close/i)).toBeInTheDocument();
  });

  it('surfaces the save-failed inline error from the mutation state', async () => {
    const user = userEvent.setup({ delay: null });
    mockIsError = true;
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' oops');
    expect(screen.getAllByText("Couldn't save — try again")[0]).toBeInTheDocument();
  });

  it('shows the Saving… label and disables Save while the mutation is in flight', async () => {
    const user = userEvent.setup({ delay: null });
    mockIsSaving = true;
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' wip');
    const saving = desktop().getByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    // Cancel stays enabled during a save so the user can always back out.
    expect(desktop().getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('reverts the draft and clears the bar when Cancel is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ name: 'Foundation' });
    TASKS = [task];
    renderDrawer(task);

    const name = desktop().getByLabelText('Task name');
    await user.type(name, ' edited');
    await waitFor(() => expect(name).toHaveValue('Foundation edited'));
    await user.click(desktop().getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(desktop().getByLabelText('Task name')).toHaveValue('Foundation'));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('blocks Save on an out-of-order estimate triple with a validation message', async () => {
    const user = userEvent.setup({ delay: null });
    // Complete but out-of-order triple (10 ≤ 5 ≤ 1 is false) → server would 400.
    const task = makeTask({
      optimisticDuration: 10,
      mostLikelyDuration: 5,
      pessimisticDuration: 1,
    } as Partial<Task>);
    TASKS = [task];
    renderDrawer(task);

    // Dirty via the name so the bar appears while the estimate triple stays invalid.
    await user.type(desktop().getByLabelText('Task name'), ' x');
    expect(desktop().getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(
      screen.getAllByText(/Optimistic ≤ Most Likely ≤ Pessimistic/)[0],
    ).toBeInTheDocument();
  });
});

describe('TaskDetailDrawer Cmd/Ctrl+S', () => {
  it('saves the dirty draft on Cmd+S', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ serverVersion: 4 });
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' keyboard');
    await user.keyboard('{Meta>}s{/Meta}');

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ id: 't1', baseVersion: 4 });
  });

  it('does not intercept Cmd+S while the draft is clean', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    await user.keyboard('{Meta>}s{/Meta}');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('TaskDetailDrawer close guard', () => {
  it('closes immediately when clean', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { onClose } = renderDrawerHarness(task);

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('raises the unsaved-changes guard when dirty and keeps the drawer on Keep editing', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { onClose } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' z');
    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);

    const guard = screen.getByRole('alertdialog');
    expect(within(guard).getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discards and closes when Discard is chosen from the guard', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { onClose } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' z');
    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // #2153: unstaged composer text must raise the same guard on close, without
  // masquerading as a scalar edit (no Save bar).
  it('raises the guard on close when only a composer has unstaged text', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'composertest' });
    TASKS = [task];
    const { onClose } = renderDrawerHarness(task);

    // Clean start: no Save bar, close is unguarded.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    // Details-tab registry sections start collapsed — expand the probe's section.
    await user.click(desktop().getByRole('button', { name: /Discussion/i }));
    await user.click(desktop().getByRole('button', { name: 'type-comment' }));
    // Composer text is NOT a scalar edit — the Save bar stays hidden.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    // Closing now prompts the guard instead of silently destroying the text.
    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    const guard = screen.getByRole('alertdialog');
    expect(within(guard).getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Keep editing returns to the drawer with the composer intact.
    await user.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TaskDetailDrawer expand', () => {
  it('navigates to the full-page task view and closes when clean', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1' });
    TASKS = [task];
    const { onClose } = renderDrawerHarness(task);

    await user.click(screen.getAllByRole('button', { name: 'Expand to full page' })[0]);
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/tasks/t1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards the expand when dirty and navigates only after Discard', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1' });
    TASKS = [task];
    renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' q');
    await user.click(screen.getAllByRole('button', { name: 'Expand to full page' })[0]);
    // Guard intercepts — no navigation yet.
    expect(navigateSpy).not.toHaveBeenCalled();

    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }),
    );
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/tasks/t1');
  });

  it('keeps editing (no navigation) when the expand guard is dismissed', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1' });
    TASKS = [task];
    renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' q');
    await user.click(screen.getAllByRole('button', { name: 'Expand to full page' })[0]);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }),
    );

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('TaskDetailDrawer swap-while-dirty', () => {
  it('reseeds instantly with no guard on a clean swap', () => {
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    rerenderTask(next);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Framing');
  });

  it('raises the three-verb guard on a dirty swap and stays put on Keep editing', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask, onSwapCanceled } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    rerenderTask(next);

    const guard = screen.getByRole('alertdialog');
    expect(guard).toHaveTextContent('Foundation');
    expect(guard).toHaveTextContent('Framing');
    expect(within(guard).getByRole('button', { name: 'Save & open' })).toBeInTheDocument();

    await user.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    // Host asked to restore its prior selection; the current (edited) task stays.
    expect(onSwapCanceled).toHaveBeenCalledWith('t1');
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Foundation edit');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('discards the draft and adopts the pending task on Discard & open', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    rerenderTask(next);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard & open' }),
    );

    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Framing');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('saves the current task then adopts the pending one on Save & open', async () => {
    const user = userEvent.setup({ delay: null });
    mutate.mockImplementation((_payload, opts) => opts?.onSuccess?.());
    const task = makeTask({ id: 't1', name: 'Foundation', serverVersion: 9 });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    rerenderTask(next);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save & open' }),
    );

    // The current task is PATCHed (with its baseVersion) before the swap resolves…
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ id: 't1', baseVersion: 9 });
    // …then the drawer adopts the pending task.
    await waitFor(() => expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Framing'));
  });

  it('does not save or swap on Save & open when the estimate triple is invalid', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({
      id: 't1',
      name: 'Foundation',
      optimisticDuration: 10,
      mostLikelyDuration: 5,
      pessimisticDuration: 1,
    } as Partial<Task>);
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    rerenderTask(next);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save & open' }),
    );

    // Guard stays open, nothing persisted, pending task never adopted.
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Foundation edit');
  });
});

describe('TaskDetailDrawer tabs', () => {
  it('shows only the Details tab for a task with no registered sections', () => {
    const task = makeTask({ id: 't1' });
    TASKS = [task];
    renderDrawer(task);

    expect(desktop().getByRole('tab', { name: 'Details' })).toBeInTheDocument();
    expect(desktop().queryByRole('tab', { name: /Subtasks/ })).not.toBeInTheDocument();
    expect(desktop().queryByRole('tab', { name: /Activity/ })).not.toBeInTheDocument();
  });

  it('reveals the Subtasks/Activity tabs, the done/total badge, and switches panels', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'tabtest', name: 'Phase' });
    const done = makeTask({ id: 'c1', parentId: 'tabtest', isSubtask: true, status: 'COMPLETE' });
    const open = makeTask({
      id: 'c2',
      parentId: 'tabtest',
      isSubtask: true,
      status: 'IN_PROGRESS',
    } as Partial<Task>);
    TASKS = [task, done, open];
    renderDrawer(task);

    const subtasksTab = desktop().getByRole('tab', { name: /Subtasks/ });
    expect(subtasksTab).toBeInTheDocument();
    expect(desktop().getByRole('tab', { name: /Activity/ })).toBeInTheDocument();
    // 1 of the 2 subtasks is COMPLETE.
    expect(within(subtasksTab).getByText('1/2')).toBeInTheDocument();

    await user.click(subtasksTab);
    expect(desktop().getAllByText('subtasks-panel-body')[0]).toBeInTheDocument();
  });

  it('moves selection across tabs with the arrow keys (WAI-ARIA tab pattern)', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'tabtest', name: 'Phase' });
    const child = makeTask({ id: 'c1', parentId: 'tabtest', isSubtask: true, status: 'COMPLETE' });
    TASKS = [task, child];
    renderDrawer(task);

    const detailsTab = desktop().getByRole('tab', { name: 'Details' });
    detailsTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(desktop().getByRole('tab', { name: /Subtasks/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(detailsTab).toHaveAttribute('aria-selected', 'false');
  });
});

describe('SectionList', () => {
  it('renders the empty-state copy when there are no sections', () => {
    render(<SectionList sections={[]} taskId="t1" projectId="p1" />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('renders a section header and, for the sprint section, the configured iteration label', () => {
    render(
      <SectionList
        sections={[
          {
            id: 'sprint',
            priority: 1,
            title: 'Static sprint title (ignored)',
            component: () => <div>sprint-section-body</div>,
          },
        ]}
        taskId="t1"
        projectId="p1"
      />,
    );
    // The static 'sprint' title is replaced by the resolved iteration label.
    expect(screen.getByRole('button', { name: /Sprint/ })).toBeInTheDocument();
    // firstOpen defaults true → the first section is expanded and its body mounts.
    expect(screen.getByText('sprint-section-body')).toBeInTheDocument();
  });

  it('uses the registered title for a non-sprint section', () => {
    render(
      <SectionList
        sections={[
          {
            id: 'dependencies',
            priority: 1,
            title: 'Dependencies',
            component: () => <div>deps-body</div>,
          },
        ]}
        taskId="t1"
        projectId="p1"
      />,
    );
    expect(screen.getByRole('button', { name: /Dependencies/ })).toBeInTheDocument();
  });
});
