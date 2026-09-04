import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';

import type { Task } from '@/types';
import { registry, type DrawerSectionContext } from '@/lib/widget-registry';
import { useDrawerSectionStore } from '@/stores/drawerSectionStore';
import { TaskDetailDrawer, SectionList } from './TaskDetailDrawer';
import { useReportComposerDirty } from './ComposerDirtyContext';
import { useTaskDraft } from './TaskDraftContext';
import { axiosRefusal } from '@/test/axiosError';

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
// The REAL error object, not a boolean: the drawer now shapes the refusal itself
// (`describeWriteRefusal`), so a mock that only carried `isError` would exercise
// the slot and never the wiring (#3332).
let mockSaveError: unknown = null;
// `reset` is the mutation's own, NOT `useDirtyDraft`'s — the drawer calls it to
// retire a refusal when the subject changes or the draft is edited (web-rule 376).
// Clearing the module-level `mockSaveError` is what makes the mock model TanStack's
// actual behavior: without it the spy records the call and the error never goes away,
// which would pass a call-count assertion while the defect is still on screen.
const resetSaveMutation = vi.fn(() => {
  mockIsError = false;
  mockSaveError = null;
});
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({
    mutate,
    isPending: mockIsSaving,
    isError: mockIsError,
    error: mockSaveError,
    reset: resetSaveMutation,
  }),
}));

// Spy on navigation so the Expand → full-page path is assertable while keeping
// the real MemoryRouter (imported below) for the surrounding route context.
const navigateSpy = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

let TASKS: Partial<Task>[] | undefined = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: TASKS, isLoading: false }),
}));
// The drawer is a desktop non-modal inspector at `md`+ and a modal bottom sheet
// at `sm`; the breakpoint drives the focus-trap and the focus-restore ladder, so
// it is mutable per test rather than fixed at the jsdom default.
let mockBreakpoint: 'sm' | 'md' | 'lg' = 'lg';
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => mockBreakpoint }));
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
// A minimal controlled stand-in for the real field (which owns a read/edit mode
// plus scroll restoration, covered by its own suite). It keeps the ONE thing the
// drawer contract depends on — value in / onChange out — so the notes half of the
// deferred draft (patch key, conflict label, unsaved marker) is exercisable here.
vi.mock('./TaskDescriptionField', () => ({
  TaskDescriptionField: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (v: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Description"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
// The header chip calls useProject (a real useQuery); this suite mocks data
// hooks rather than providing a QueryClient, so stub the chip like the strip.
vi.mock('./HeaderEstimateChip', () => ({ HeaderEstimateChip: () => <div /> }));
// Reads useTaskHistory (a real query); this suite mocks data hooks rather than
// providing a QueryClient, so stub it — but keep the "view all activity" handoff
// callable, since the drawer (not the digest) owns what that button does (#2448).
vi.mock('./DrawerRecentActivity', () => ({
  DrawerRecentActivity: ({ onViewActivity }: { onViewActivity: () => void }) => (
    <button type="button" onClick={onViewActivity}>
      view-all-activity
    </button>
  ),
}));

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
  mockSaveError = null;
  resetSaveMutation.mockClear();
  mockBreakpoint = 'lg';
  // The section open/reveal store is module-global and session-scoped by design,
  // so clear it between cases or a reveal leaks into the next test.
  useDrawerSectionStore.setState({ overrides: {}, revealed: {} });
  document.querySelectorAll('main').forEach((el) => el.remove());
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
  // Progressive-disclosure fixtures (ADR-0605), scoped to task id 'disclosure':
  // an Overview section (rendered inline, not behind an accordion), one populated
  // section, one section with no `tab` (the backward-compatible default), and two
  // EMPTY optional sections — one of which is 'sprint', whose label resolves to
  // the configured iteration label rather than its static registered title.
  const onlyDisclosure = (ctx: unknown): boolean =>
    (ctx as DrawerSectionContext).task != null &&
    ((ctx as DrawerSectionContext).task as Task).id === 'disclosure';
  registry.register('task_detail.section', {
    id: 'overview',
    priority: 100,
    title: 'Overview',
    tab: 'details',
    component: ({ canEdit }: { canEdit?: boolean }) => (
      <div>overview-body:{canEdit ? 'editable' : 'readonly'}</div>
    ),
    canRender: onlyDisclosure,
  });
  registry.register('task_detail.section', {
    id: 'dependencies',
    priority: 200,
    title: 'Dependencies',
    tab: 'details',
    component: () => <div>dependencies-body</div>,
    canRender: onlyDisclosure,
    isPopulated: () => true,
  });
  registry.register('task_detail.section', {
    id: 'untabbed',
    priority: 250,
    title: 'Untabbed',
    // No `tab` — must fall into `details` (the extension-point default).
    component: () => <div>untabbed-body</div>,
    canRender: onlyDisclosure,
  });
  registry.register('task_detail.section', {
    id: 'sprint',
    priority: 300,
    title: 'Static sprint title (ignored)',
    tab: 'details',
    component: () => <div>sprint-body</div>,
    canRender: onlyDisclosure,
    isPopulated: () => false,
  });
  registry.register('task_detail.section', {
    id: 'recurring',
    priority: 700,
    title: 'Recurring',
    tab: 'details',
    component: () => <div>recurring-body</div>,
    canRender: onlyDisclosure,
    isPopulated: () => false,
  });
  // Estimate-draft consumer (#1985) — the contract EstimatesTab opts into, so
  // the drawer's staged estimate binding can be driven without the real tab.
  registry.register('task_detail.section', {
    id: 'test-estimates',
    priority: 800,
    title: 'Estimates',
    tab: 'details',
    component: () => <EstimateProbe />,
    canRender: (ctx: unknown) =>
      (ctx as DrawerSectionContext).task != null &&
      ((ctx as DrawerSectionContext).task as Task).id === 'estimatetest',
  });
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

/**
 * Stands in for EstimatesTab: binds the three staged estimate fields through
 * TaskDraftContext (never through its own endpoint), so Save must carry them.
 */
function EstimateProbe() {
  const binding = useTaskDraft();
  if (!binding) return <div>estimate-probe-unbound</div>;
  return (
    <div>
      <input
        aria-label="probe optimistic"
        value={binding.values.optimistic}
        onChange={(e) => binding.setField('optimistic', e.target.value)}
      />
      <input
        aria-label="probe most likely"
        value={binding.values.mostLikely}
        onChange={(e) => binding.setField('mostLikely', e.target.value)}
      />
      <input
        aria-label="probe pessimistic"
        value={binding.values.pessimistic}
        onChange={(e) => binding.setField('pessimistic', e.target.value)}
      />
      <button type="button" onClick={() => binding.commitField('mostLikely', '42')}>
        probe-rebaseline
      </button>
      <span>{binding.changed.optimistic ? 'optimistic-changed' : 'optimistic-clean'}</span>
    </div>
  );
}

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

describe('TaskDetailDrawer changed-elsewhere signal across all staged fields (#2172)', () => {
  it('warns and names Estimates when the server estimate changes under a dirty draft', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({
      optimisticDuration: 1,
      mostLikelyDuration: 2,
      pessimisticDuration: 3,
    });
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    const dialog = within(screen.getAllByRole('dialog')[0]);
    // Dirty the draft (edit name), leaving estimates untouched.
    await user.type(dialog.getByLabelText('Task name'), ' reworked');
    await waitFor(() =>
      expect(dialog.getByLabelText('Task name')).toHaveValue('Foundation reworked'),
    );
    // No conflict yet.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Someone else changes the estimate on the server (same task identity).
    const serverEdit = makeTask({
      optimisticDuration: 9,
      mostLikelyDuration: 2,
      pessimisticDuration: 3,
    });
    TASKS = [serverEdit];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={serverEdit} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    // Old code watched only notes → nothing. Now the save bar warns and names it.
    const alert = screen.getAllByRole('alert')[0];
    expect(alert).toHaveTextContent(/Estimates changed elsewhere/i);
    expect(alert).toHaveTextContent(/overwrite that change/i);
  });

  it('names the Name field when the server renames the task under a dirty draft', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ name: 'Foundation' });
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    const dialog = within(screen.getAllByRole('dialog')[0]);
    await user.type(dialog.getByLabelText('Task name'), ' reworked');
    await waitFor(() =>
      expect(dialog.getByLabelText('Task name')).toHaveValue('Foundation reworked'),
    );

    const serverEdit = makeTask({ name: 'Renamed On Server' });
    TASKS = [serverEdit];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={serverEdit} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/Name changed elsewhere/i);
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
      <TaskDetailDrawer task={t} projectId="p1" onClose={onClose} onSwapCanceled={onSwapCanceled} />
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

  it("surfaces the SERVER's refusal in the save bar, with no retry advice on a 400 (#3332)", async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { rerenderTask } = renderDrawerHarness(task);

    // Dirty FIRST, then the refusal lands — the real order, and the only one that
    // survives web-rule 376's "an edit retires the refusal" guard.
    await user.type(desktop().getByLabelText('Task name'), ' oops');
    mockIsError = true;
    mockSaveError = axiosRefusal(400, { name: ['This field may not be blank.'] });
    rerenderTask(task);
    const alert = screen.getAllByTestId('dialog-footer-error')[0];
    expect(alert).toHaveTextContent('This field may not be blank.');
    // The hardcoded sentence this slot used to render, which discarded the field
    // error above and then advised the one act a 400 has already ruled out.
    expect(alert).not.toHaveTextContent(/try again/i);
  });

  it('falls back to a plain sentence when the failure carries no readable body', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' oops');
    mockIsError = true;
    mockSaveError = new Error('Network Error');
    rerenderTask(task);
    expect(screen.getAllByTestId('dialog-footer-error')[0]).toHaveTextContent(
      "Couldn't save the task.",
    );
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
    expect(screen.getAllByText(/Optimistic ≤ Most Likely ≤ Pessimistic/)[0]).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// Branch coverage (#2459): the deferred notes/estimate draft keys, the conflict
// wording, the focus-restore ladder, the mobile sheet, progressive disclosure,
// and the remaining guard early-returns.
// ---------------------------------------------------------------------------

function renderDrawerWith(
  task: Task,
  props: {
    onClose?: () => void;
    getRestoreTarget?: (taskId: string) => HTMLElement | null;
  } = {},
) {
  return render(
    <MemoryRouter>
      <TaskDetailDrawer
        task={task}
        projectId="p1"
        onClose={props.onClose ?? (() => {})}
        getRestoreTarget={props.getRestoreTarget}
      />
    </MemoryRouter>,
  );
}

/** jsdom performs no layout, so `offsetParent` is always null — the drawer's
 *  "is this node still usable as a focus target" probe needs it stubbed. */
function makeVisible(el: HTMLElement): HTMLElement {
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  return el;
}

describe('TaskDetailDrawer description (deferred notes draft)', () => {
  it('batches a description edit into the same PATCH as the name', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ notes: 'pour the slab' } as Partial<Task>);
    TASKS = [task];
    renderDrawer(task);

    await user.clear(desktop().getByLabelText('Description'));
    await user.type(desktop().getByLabelText('Description'), 'pour and cure');
    await user.type(desktop().getByLabelText('Task name'), '!');
    await waitFor(() =>
      expect(desktop().getByLabelText<HTMLTextAreaElement>('Description').value).toBe(
        'pour and cure',
      ),
    );
    await user.click(desktop().getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      name: 'Foundation!',
      notes: 'pour and cure',
    });
  });

  it('names Description (not Name) in the unsaved-scope announcement', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ notes: '' } as Partial<Task>);
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Description'), 'a note');
    expect(screen.getAllByText('Unsaved changes: Description')[0]).toBeInTheDocument();
  });

  it('renders the description read-only for a non-editable task', () => {
    const task = makeTask({ canEdit: false });
    TASKS = [task];
    renderDrawer(task);
    expect(desktop().getByLabelText('Description')).toHaveAttribute('readonly');
  });
});

describe('TaskDetailDrawer staged estimates (#1985)', () => {
  async function openEstimates(user: ReturnType<typeof userEvent.setup>) {
    await user.click(desktop().getByRole('button', { name: /^Estimates$/i }));
  }

  it('carries all three estimate columns in the batched PATCH', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'estimatetest' });
    TASKS = [task];
    renderDrawer(task);

    await openEstimates(user);
    await user.type(desktop().getByLabelText('probe optimistic'), '2');
    await user.type(desktop().getByLabelText('probe most likely'), '4');
    await user.type(desktop().getByLabelText('probe pessimistic'), '6');
    await waitFor(() =>
      expect(desktop().getByLabelText<HTMLInputElement>('probe pessimistic').value).toBe('6'),
    );
    // The per-field dirty flag the section renders its "•" marker from.
    expect(desktop().getByText('optimistic-changed')).toBeInTheDocument();

    await user.click(desktop().getByRole('button', { name: 'Save' }));
    expect(mutate.mock.calls[0][0]).toMatchObject({
      optimistic_duration: 2,
      most_likely_duration: 4,
      pessimistic_duration: 6,
    });
  });

  it('stages a non-numeric estimate as null rather than NaN', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'estimatetest' });
    TASKS = [task];
    renderDrawer(task);

    await openEstimates(user);
    await user.type(desktop().getByLabelText('probe optimistic'), 'abc');
    await waitFor(() =>
      expect(desktop().getByLabelText<HTMLInputElement>('probe optimistic').value).toBe('abc'),
    );
    await user.click(desktop().getByRole('button', { name: 'Save' }));

    expect(mutate.mock.calls[0][0]).toMatchObject({ optimistic_duration: null });
  });

  it('re-baselines a single field via commitField without raising the save bar', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'estimatetest' });
    TASKS = [task];
    renderDrawer(task);

    await openEstimates(user);
    await user.click(desktop().getByRole('button', { name: 'probe-rebaseline' }));

    await waitFor(() =>
      expect(desktop().getByLabelText<HTMLInputElement>('probe most likely').value).toBe('42'),
    );
    // A side-write that the server already applied is not a pending edit.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('TaskDetailDrawer conflict wording (#2172)', () => {
  const dirtyTask = () =>
    makeTask({
      name: 'Foundation',
      notes: 'orig',
      optimisticDuration: 1,
      mostLikelyDuration: 2,
      pessimisticDuration: 3,
    } as Partial<Task>);

  it('joins two drifted fields with "and" and pluralizes the overwrite warning', async () => {
    const user = userEvent.setup({ delay: null });
    const task = dirtyTask();
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' mine');
    await user.type(desktop().getByLabelText('Description'), ' mine');
    await waitFor(() =>
      expect(desktop().getByLabelText('Task name')).toHaveValue('Foundation mine'),
    );

    const serverEdit = makeTask({
      name: 'Server rename',
      notes: 'server note',
      optimisticDuration: 1,
      mostLikelyDuration: 2,
      pessimisticDuration: 3,
    } as Partial<Task>);
    TASKS = [serverEdit];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={serverEdit} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    const alert = screen.getAllByRole('alert')[0];
    expect(alert).toHaveTextContent(/Name and Description changed elsewhere/i);
    expect(alert).toHaveTextContent(/overwrite those changes/i);
  });

  it('uses a serial join for three drifted fields', async () => {
    const user = userEvent.setup({ delay: null });
    const task = dirtyTask();
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' mine');
    await user.type(desktop().getByLabelText('Description'), ' mine');
    await waitFor(() =>
      expect(desktop().getByLabelText('Task name')).toHaveValue('Foundation mine'),
    );

    const serverEdit = makeTask({
      name: 'Server rename',
      notes: 'server note',
      optimisticDuration: 5,
      mostLikelyDuration: 6,
      pessimisticDuration: 7,
    } as Partial<Task>);
    TASKS = [serverEdit];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={serverEdit} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
      /Name, Description and Estimates changed elsewhere/i,
    );
  });
});

describe('TaskDetailDrawer focus restore on close (web-rule 264d)', () => {
  it('returns focus to the element that opened the drawer', async () => {
    const user = userEvent.setup({ delay: null });
    const opener = makeVisible(document.createElement('button'));
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const task = makeTask();
    TASKS = [task];
    renderDrawerWith(task);

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('falls back to the host-provided restore target when there is no usable opener', async () => {
    const user = userEvent.setup({ delay: null });
    const hostTarget = makeVisible(document.createElement('button'));
    document.body.appendChild(hostTarget);
    const getRestoreTarget = vi.fn<(taskId: string) => HTMLElement | null>(() => hostTarget);

    const task = makeTask({ id: 't1' });
    TASKS = [task];
    renderDrawerWith(task, { getRestoreTarget });

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(getRestoreTarget).toHaveBeenCalledWith('t1');
    expect(hostTarget).toHaveFocus();
    hostTarget.remove();
  });

  it('falls back to <main> and makes it programmatically focusable', async () => {
    const user = userEvent.setup({ delay: null });
    const main = document.createElement('main');
    document.body.appendChild(main);

    const task = makeTask();
    TASKS = [task];
    renderDrawerWith(task, { getRestoreTarget: () => null });

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveFocus();
  });

  it('leaves an already-focusable <main> tabindex untouched', async () => {
    const user = userEvent.setup({ delay: null });
    const main = document.createElement('main');
    main.setAttribute('tabindex', '0');
    document.body.appendChild(main);

    const task = makeTask();
    TASKS = [task];
    renderDrawerWith(task);

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(main).toHaveAttribute('tabindex', '0');
    expect(main).toHaveFocus();
  });

  it('does not run the desktop ladder on mobile — the sheet trap owns restore', async () => {
    mockBreakpoint = 'sm';
    const user = userEvent.setup({ delay: null });
    const main = document.createElement('main');
    document.body.appendChild(main);

    const task = makeTask();
    TASKS = [task];
    renderDrawerWith(task);

    await user.click(screen.getAllByRole('button', { name: 'Close task detail' })[0]);
    expect(main).not.toHaveAttribute('tabindex');
  });
});

describe('TaskDetailDrawer keyboard details', () => {
  it('blurs the name input on Enter instead of submitting anything', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    renderDrawer(task);

    const name = desktop().getByLabelText('Task name');
    name.focus();
    await user.keyboard('{Enter}');
    expect(name).not.toHaveFocus();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('ignores non-arrow keys on the tab strip', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'tabtest' });
    TASKS = [task];
    renderDrawer(task);

    const details = desktop().getByRole('tab', { name: 'Details' });
    details.focus();
    await user.keyboard('{End}');
    expect(details).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps to the last tab on ArrowLeft from the first', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'tabtest' });
    TASKS = [task];
    renderDrawer(task);

    desktop().getByRole('tab', { name: 'Details' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(desktop().getByRole('tab', { name: /Activity/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('TaskDetailDrawer Cmd+S guards', () => {
  it('does not save on Cmd+S while the estimate triple is out of order', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({
      optimisticDuration: 10,
      mostLikelyDuration: 5,
      pessimisticDuration: 1,
    } as Partial<Task>);
    TASKS = [task];
    renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' x');
    await user.keyboard('{Control>}s{/Control}');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does not save on Cmd+S once the task was deleted out from under the draft', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' x');
    await waitFor(() => expect(desktop().getByLabelText('Task name')).toHaveValue('Foundation x'));

    TASKS = [sibling];
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );
    await screen.findAllByRole('alert');

    await user.keyboard('{Meta>}s{/Meta}');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('TaskDetailDrawer deleted-banner verbs (#2054)', () => {
  async function deleteUnderDirtyDraft(user: ReturnType<typeof userEvent.setup>, name = ' x') {
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const onClose = vi.fn();
    const ui = (t: Task | null) => (
      <MemoryRouter>
        <TaskDetailDrawer task={t} projectId="p1" onClose={onClose} />
      </MemoryRouter>
    );
    const { rerender } = render(ui(task));
    if (name === '') {
      await user.clear(desktop().getByLabelText('Task name'));
      await waitFor(() => expect(desktop().getByLabelText('Task name')).toHaveValue(''));
    } else {
      await user.type(desktop().getByLabelText('Task name'), name);
      await waitFor(() =>
        expect(desktop().getByLabelText('Task name')).toHaveValue(`Foundation${name}`),
      );
    }
    TASKS = [sibling];
    rerender(ui(null));
    await screen.findAllByRole('alert');
    return onClose;
  }

  it('tears the orphaned drawer down on Dismiss', async () => {
    const user = userEvent.setup({ delay: null });
    const onClose = await deleteUnderDirtyDraft(user);

    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels an empty name draft with the NEUTRAL noun in the rescued text', async () => {
    const user = userEvent.setup({ delay: null });
    await deleteUnderDirtyDraft(user, '');

    await user.click(screen.getAllByRole('button', { name: 'Copy my text' })[0]);
    // "Untitled item", not "Untitled task" (#3031): this drawer opens for
    // whatever row was clicked and has no milestone or phase handling at all,
    // so a blank-named row must not be rescued under a type it may not hold.
    // Pinned in both directions — the retired word must be ABSENT, or the
    // assertion would still pass if the noun regressed alongside it.
    const rescued = await navigator.clipboard.readText();
    expect(rescued).toContain('Untitled item');
    expect(rescued).not.toContain('Untitled task');
  });

  it('keeps the banner usable when the clipboard write is blocked', async () => {
    const user = userEvent.setup({ delay: null });
    await deleteUnderDirtyDraft(user);
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('blocked'));

    await user.click(screen.getAllByRole('button', { name: 'Copy my text' })[0]);
    // No crash, no false "Copied" confirmation — the text stays on screen.
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getAllByRole('button', { name: 'Copy my text' })[0]).toBeInTheDocument();
    writeText.mockRestore();
  });
});

describe('TaskDetailDrawer swap guard edges (#1978)', () => {
  it('ignores Escape while a Save & open is in flight', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask, onSwapCanceled } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    mockIsSaving = true;
    rerenderTask(next);

    await user.keyboard('{Escape}');
    // Canceling now would race the in-flight onSuccess and desync the host.
    expect(onSwapCanceled).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows the save error inside the swap dialog and keeps the pending task', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    mockIsError = true;
    mockSaveError = axiosRefusal(403, { detail: 'You cannot edit this task.' });
    rerenderTask(next);

    const guard = within(screen.getByRole('alertdialog'));
    expect(guard.getByRole('alert')).toHaveTextContent('You cannot edit this task.');
    expect(guard.getByRole('button', { name: 'Save & open' })).toBeInTheDocument();
  });

  it('reseeds without a PATCH when only composer text was dirty', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'composertest', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.click(desktop().getByRole('button', { name: /Discussion/i }));
    await user.click(desktop().getByRole('button', { name: 'type-comment' }));
    rerenderTask(next);

    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save & open' }),
    );
    // Nothing scalar changed, so there is nothing to persist — just adopt the task.
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Framing');
  });
});

describe('TaskDetailDrawer progressive disclosure (ADR-0605)', () => {
  it('shows populated sections and folds empty ones under Add detail', () => {
    const task = makeTask({ id: 'disclosure' });
    TASKS = [task];
    renderDrawer(task);

    // Populated + always-shown (no predicate) sections keep their headers…
    expect(desktop().getByRole('button', { name: /Dependencies/ })).toBeInTheDocument();
    expect(desktop().getByRole('button', { name: /Untabbed/ })).toBeInTheDocument();
    // …the empty ones are offered under "Add detail" instead of empty headers.
    const addDetail = within(desktop().getByRole('region', { name: 'Add detail' }));
    expect(addDetail.getByRole('button', { name: 'Sprint' })).toBeInTheDocument();
    expect(addDetail.getByRole('button', { name: 'Recurring' })).toBeInTheDocument();
  });

  it('renders the Overview section inline with the effective edit verdict', () => {
    const task = makeTask({ id: 'disclosure', canEdit: true });
    TASKS = [task];
    renderDrawer(task);
    expect(desktop().getByText('overview-body:editable')).toBeInTheDocument();
  });

  it('re-adds a revealed section to the main flow and opens it', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'disclosure' });
    TASKS = [task];
    renderDrawer(task);

    await user.click(
      within(desktop().getByRole('region', { name: 'Add detail' })).getByRole('button', {
        name: 'Sprint',
      }),
    );

    // It leaves the Add-detail row and mounts expanded — no second click needed.
    expect(desktop().getByText('sprint-body')).toBeInTheDocument();
    expect(
      within(desktop().getByRole('region', { name: 'Add detail' })).queryByRole('button', {
        name: 'Sprint',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('TaskDetailDrawer activity handoff (#2448)', () => {
  it('switches to the Activity tab from the recent-activity digest', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 'tabtest' });
    TASKS = [task];
    renderDrawer(task);

    expect(desktop().getByRole('tab', { name: /Activity/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await user.click(desktop().getByRole('button', { name: 'view-all-activity' }));

    expect(desktop().getByRole('tab', { name: /Activity/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(desktop().getByText('activity-panel-body')).toBeInTheDocument();
  });
});

describe('TaskDetailDrawer open / cache edges', () => {
  it('seeds the draft when the drawer opens from closed', () => {
    TASKS = [];
    const { rerenderTask } = renderDrawerHarness(null);
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();

    const task = makeTask({ name: 'Foundation' });
    TASKS = [task];
    rerenderTask(task);
    expect(screen.getAllByLabelText('Task name')[0]).toHaveValue('Foundation');
  });

  it('renders with an unloaded task cache (no subtask badge, no crash)', () => {
    TASKS = undefined;
    const task = makeTask({ id: 'tabtest' });
    renderDrawer(task);
    // Sections still register; the derived done/total badge simply has nothing to count.
    expect(desktop().getByRole('tab', { name: 'Subtasks' })).toBeInTheDocument();
  });

  it('closes instead of raising the rescue banner when the task cache is unavailable', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1' });
    TASKS = [task];
    const { rerender } = renderDrawer(task);

    await user.type(desktop().getByLabelText('Task name'), ' x');
    await waitFor(() => expect(desktop().getByLabelText('Task name')).toHaveValue('Foundation x'));

    // Without a loaded list we cannot prove the task was deleted, so the drawer
    // must not claim it was — it takes the ordinary close path.
    TASKS = undefined;
    rerender(
      <MemoryRouter>
        <TaskDetailDrawer task={null} projectId="p1" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
  });

  it('falls back to the client role rule when the task carries no canEdit verdict', () => {
    const task = makeTask({ canEdit: undefined });
    TASKS = [task];
    renderDrawer(task);
    // The mocked role is below MEMBER, so the client rule denies the edit.
    expect(desktop().getByText('View only')).toBeInTheDocument();
  });
});

/**
 * A refusal is a statement about the payload that was submitted (web-rule 376).
 *
 * These three all passed silently before #3332 and all became defects the moment
 * the sentence got specific: `"Couldn't save — try again"` going stale is noise,
 * `"You do not have permission to edit this task."` on a row the user never
 * submitted is the product stating something false.
 */
describe('TaskDetailDrawer — retiring a stale refusal (#3332, web-rule 376)', () => {
  it('does NOT carry task A’s refusal onto task B after a discard-and-open swap', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    // Dirty A, refuse A's save, then point the drawer at B — the guard is raised.
    await user.type(desktop().getByLabelText('Task name'), ' edit');
    mockIsError = true;
    mockSaveError = axiosRefusal(403, { detail: 'You cannot edit this task.' });
    rerenderTask(next);
    await user.click(screen.getByRole('button', { name: 'Discard & open' }));

    // B is now the subject. Its first edit remounts the save bar — with nothing
    // in it, because the refusal belonged to A and A is gone.
    await user.type(desktop().getByLabelText('Task name'), ' edit');
    expect(screen.queryByTestId('dialog-footer-error')).toBeNull();
    expect(screen.queryByText('You cannot edit this task.')).toBeNull();
  });

  it('retires the refusal on the very edit that could have fixed it', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask();
    TASKS = [task];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' oops');
    mockIsError = true;
    mockSaveError = axiosRefusal(400, { name: ['This field may not be blank.'] });
    rerenderTask(task);
    expect(screen.getAllByTestId('dialog-footer-error')[0]).toHaveTextContent(
      'This field may not be blank.',
    );

    // The next keystroke is the user doing the thing the sentence asked for.
    await user.type(desktop().getByLabelText('Task name'), 'a');
    expect(resetSaveMutation).toHaveBeenCalled();
    expect(screen.queryByText('This field may not be blank.')).toBeNull();
  });

  it('shows the refusal in the swap guard ONLY — never in both live regions at once', async () => {
    const user = userEvent.setup({ delay: null });
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const next = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, next];
    const { rerenderTask } = renderDrawerHarness(task);

    await user.type(desktop().getByLabelText('Task name'), ' edit');
    mockIsError = true;
    mockSaveError = axiosRefusal(403, { detail: 'You cannot edit this task.' });
    rerenderTask(next);

    // Both surfaces are mounted (the guard only fires while dirty, which is
    // exactly when the save bar is up), so two copies would be announced twice.
    expect(screen.getAllByText('You cannot edit this task.')).toHaveLength(1);
    expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toHaveTextContent(
      'You cannot edit this task.',
    );
    expect(screen.queryByTestId('dialog-footer-error')).toBeNull();
  });
});
