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
