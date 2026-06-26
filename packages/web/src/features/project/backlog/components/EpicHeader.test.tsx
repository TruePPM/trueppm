import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import type { EpicGroup } from '../types';
import { EpicHeader } from './EpicHeader';

// EpicHeader owns its rename/delete mutations; mock the hook module so the test
// controls the mutation outcome and asserts the calls (mirrors StoryDetailDrawer.test).
const h = vi.hoisted(() => {
  const renameMutate =
    vi.fn<(vars: { epicId: string; name: string }, opts?: { onSuccess?: () => void }) => void>();
  const deleteMutate =
    vi.fn<(vars: { epicId: string }, opts?: { onSuccess?: () => void }) => void>();
  return {
    renameMutate,
    deleteMutate,
    rename: { mutate: renameMutate, isPending: false, isError: false, reset: vi.fn() },
    del: { mutate: deleteMutate, isPending: false, isError: false, reset: vi.fn() },
  };
});

vi.mock('../hooks/useProductBacklog', () => ({
  useRenameEpic: () => h.rename,
  useDeleteEpic: () => h.del,
}));

function makeGroup(
  epicOver: Partial<Task> = {},
  rollup = { storyCount: 0, pointsTotal: 0, pointsDone: 0 },
): EpicGroup {
  return {
    epic: {
      id: 'EP1',
      name: 'Platform Core',
      shortId: 'PROJ-EP1',
      taskType: 'epic',
      canEdit: true,
      canDelete: true,
      ...epicOver,
    } as unknown as Task,
    stories: [],
    rollup,
  };
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Epic actions: Platform Core' }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rename.isPending = false;
  h.rename.isError = false;
  h.del.isPending = false;
  h.del.isError = false;
  // Default: succeed immediately so editing/dialog close on commit.
  h.renameMutate.mockImplementation((_vars, opts?: { onSuccess?: () => void }) =>
    opts?.onSuccess?.(),
  );
  h.deleteMutate.mockImplementation((_vars, opts?: { onSuccess?: () => void }) =>
    opts?.onSuccess?.(),
  );
});

describe('EpicHeader gating (#1339)', () => {
  it('a manager (canEdit + canDelete) gets a kebab with Rename and Delete', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete epic/i })).toBeInTheDocument();
  });

  it('a Product Owner (canEdit, NOT canDelete) sees Rename but not Delete', async () => {
    render(<EpicHeader group={makeGroup({ canDelete: false })} projectId="p1" />);
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /delete epic/i })).not.toBeInTheDocument();
  });

  it('a viewer (neither canEdit nor canDelete) sees no kebab at all', () => {
    render(<EpicHeader group={makeGroup({ canEdit: false, canDelete: false })} projectId="p1" />);
    expect(
      screen.queryByRole('button', { name: 'Epic actions: Platform Core' }),
    ).not.toBeInTheDocument();
  });
});

describe('EpicHeader rename (#1339)', () => {
  it('commits a changed name on Enter', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const input = screen.getByRole('textbox', { name: /rename epic platform core/i });
    await user.clear(input);
    await user.type(input, 'Platform Core & SSO{Enter}');

    expect(h.renameMutate).toHaveBeenCalledTimes(1);
    expect(h.renameMutate.mock.calls[0][0]).toEqual({ epicId: 'EP1', name: 'Platform Core & SSO' });
  });

  it('Escape cancels the rename without mutating', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const input = screen.getByRole('textbox', { name: /rename epic platform core/i });
    await user.clear(input);
    await user.type(input, 'Throwaway{Escape}');

    expect(h.renameMutate).not.toHaveBeenCalled();
    // Back to the static name, no input.
    expect(screen.queryByRole('textbox', { name: /rename epic/i })).not.toBeInTheDocument();
    expect(screen.getByText('Platform Core')).toBeInTheDocument();
  });

  it('an unchanged name is a no-op (no mutate)', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    await user.keyboard('{Enter}');
    expect(h.renameMutate).not.toHaveBeenCalled();
  });

  it('shows an inline retry alert when the rename failed', async () => {
    h.rename.isError = true;
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't rename — try again.");
  });
});

describe('EpicHeader delete (#1339)', () => {
  it('opens a confirmation naming the affected story count and deletes on confirm', async () => {
    render(<EpicHeader group={makeGroup({}, { storyCount: 3, pointsTotal: 0, pointsDone: 0 })} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /delete epic/i }));

    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /This epic has 3 stories\. They will move to Ungrouped — they are not deleted\./,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete epic' }));
    expect(h.deleteMutate).toHaveBeenCalledTimes(1);
    expect(h.deleteMutate.mock.calls[0][0]).toEqual({ epicId: 'EP1' });
  });

  it('Cancel closes the confirmation without deleting', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /delete epic/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
