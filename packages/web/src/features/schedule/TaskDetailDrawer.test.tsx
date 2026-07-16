import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import type { Task } from '@/types';
import { TaskDetailDrawer } from './TaskDetailDrawer';

// Capture the mutation call args so we can assert the drawer opts into ADR-0217
// field-level merge by declaring baseVersion (#2038).
type SavePayload = {
  id: string;
  projectId: string;
  baseVersion?: number;
  name?: string;
};
const mutate = vi.fn<(payload: SavePayload, opts?: { onSuccess?: () => void }) => void>();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false, isError: false }),
}));

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
  vi.clearAllMocks();
});

describe('TaskDetailDrawer save concurrency (#2038)', () => {
  it('passes baseVersion from the task serverVersion when saving a name edit', async () => {
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    const dialog = within(screen.getAllByRole('dialog')[0]);
    await user.type(dialog.getByLabelText('Task name'), ' reworked'); // draft is now dirty

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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
    const task = makeTask({ id: 't1', name: 'Foundation' });
    const sibling = makeTask({ id: 't2', name: 'Framing' });
    TASKS = [task, sibling];
    const { rerender } = renderDrawer(task);

    await user.clear(within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'));
    await user.type(
      within(screen.getAllByRole('dialog')[0]).getByLabelText('Task name'),
      'Rescue me',
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
});
