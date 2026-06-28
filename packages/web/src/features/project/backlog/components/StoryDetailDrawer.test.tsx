import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import { StoryDetailDrawer } from './StoryDetailDrawer';
import type { ProductBacklog } from '../types';

const patchMutate = vi.fn();
const dorMutate = vi.fn();
const updateCriterionMutate = vi.fn();

vi.mock('../hooks/useProductBacklog', () => ({
  useSetDor: () => ({ mutate: dorMutate, isPending: false }),
}));

vi.mock('../hooks/useStoryDetail', () => ({
  usePatchStory: () => ({ mutate: patchMutate, isPending: false, isError: false }),
  useCreateCriterion: () => ({ mutate: vi.fn() }),
  useUpdateCriterion: () => ({ mutate: updateCriterionMutate }),
  useDeleteCriterion: () => ({ mutate: vi.fn() }),
}));

function makeStory(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Add SSO login',
    notes: 'desc',
    shortId: 'PROJ-1A2B',
    taskType: 'story',
    parentEpic: null,
    dor: 'idea',
    storyPoints: 5,
    businessValue: 8,
    timeCriticality: 5,
    riskReduction: 5,
    jobSize: 4,
    acMet: 2,
    acTotal: 2,
    acceptanceCriteria: [
      { id: 'ac-1', text: 'Signs in with Google', met: true, position: 0 },
      { id: 'ac-2', text: 'Session persists', met: true, position: 1 },
    ],
    ...overrides,
    // Minimal canonical Task surface for fields the drawer never reads.
  } as unknown as Task;
}

const backlog: ProductBacklog = {
  epics: [],
  ungrouped: [],
  health: {
    dorPct: 0,
    readyCount: 0,
    readyPoints: 0,
    capacityPoints: null,
    unestimated: 0,
    acMet: 0,
    acTotal: 0,
    storyCount: 0,
  },
  scoring: { model: 'wsjf' },
};

function renderDrawer(story: Task, canManageBacklog = true, onClose = vi.fn()) {
  return render(
    <StoryDetailDrawer
      projectId="p1"
      story={story}
      backlog={backlog}
      canManageBacklog={canManageBacklog}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  patchMutate.mockReset();
  dorMutate.mockReset();
  updateCriterionMutate.mockReset();
});

describe('StoryDetailDrawer (#1043)', () => {
  it('renders the story fields and shows no Save bar until dirty', () => {
    renderDrawer(makeStory());
    expect(screen.getByLabelText('Story title')).toHaveValue('Add SSO login');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows the deferred Save bar once a scalar field changes, and batches the PATCH', async () => {
    const user = userEvent.setup();
    renderDrawer(makeStory());
    await user.type(screen.getByLabelText('Story title'), '!');
    const save = await screen.findByRole('button', { name: 'Save' });
    await user.click(save);
    expect(patchMutate).toHaveBeenCalledTimes(1);
    const arg = patchMutate.mock.calls[0][0] as { patch: Record<string, unknown> };
    expect(arg.patch).toMatchObject({ name: 'Add SSO login!' });
  });

  it('recalculates the WSJF score preview live as an input changes', async () => {
    const user = userEvent.setup();
    renderDrawer(makeStory());
    // (8 + 5 + 5) / 4 = 4.5
    expect(screen.getByText('4.5')).toBeInTheDocument();
    const jobSize = screen.getByLabelText('Job size');
    await user.clear(jobSize);
    await user.type(jobSize, '2');
    // (8 + 5 + 5) / 2 = 9.0 — async findBy retries past any React flush race
    // under load (the preview re-renders synchronously, so the value is
    // deterministic; the sync getByText raced the flush in a loaded CI shard).
    expect(await screen.findByText('9.0')).toBeInTheDocument();
  });

  it('disables Ready with a plain-English reason when an estimate is missing', () => {
    renderDrawer(makeStory({ storyPoints: null }));
    const ready = screen.getByRole('radio', { name: 'Ready' });
    expect(ready).toBeDisabled();
    expect(screen.getByText(/needs an estimate/i)).toBeInTheDocument();
  });

  it('enables Ready when estimated and all criteria are met', () => {
    renderDrawer(makeStory());
    expect(screen.getByRole('radio', { name: 'Ready' })).toBeEnabled();
  });

  it('renders scoring read-only (no inputs) for a caller without backlog-manage rights', () => {
    renderDrawer(makeStory(), false);
    expect(screen.queryByLabelText('Job size')).not.toBeInTheDocument();
    expect(screen.getByText(/managed by the Product Owner/i)).toBeInTheDocument();
  });

  it('ticking a criterion fires an immediate update (outside the Save batch)', async () => {
    const user = userEvent.setup();
    renderDrawer(makeStory());
    await user.click(screen.getByLabelText('Mark "Signs in with Google" met'));
    expect(updateCriterionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ criterionId: 'ac-1', patch: { met: false } }),
      expect.anything(),
    );
    expect(patchMutate).not.toHaveBeenCalled();
  });

  it('closing while dirty opens the discard dialog; Keep editing keeps the drawer open (issue 1357)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeStory(), true, onClose);

    await user.type(screen.getByLabelText('Story title'), '!');
    await user.click(screen.getByRole('button', { name: 'Close story detail' }));

    // The focus-trapped ConfirmDiscardDialog intercepts the close — not window.confirm.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closing while dirty then Discard changes closes the drawer (issue 1357)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeStory(), true, onClose);

    await user.type(screen.getByLabelText('Story title'), '!');
    await user.click(screen.getByRole('button', { name: 'Close story detail' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing while clean closes immediately without a discard dialog (issue 1357)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(makeStory(), true, onClose);

    await user.click(screen.getByRole('button', { name: 'Close story detail' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
