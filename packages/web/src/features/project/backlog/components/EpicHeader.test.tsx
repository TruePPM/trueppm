import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import type { EpicGroup } from '../types';
import { EpicHeader } from './EpicHeader';

// EpicHeader owns its delete mutation; mock the hook module so the test controls the
// outcome and asserts the call. Editing is delegated to the parent via `onOpen` (the
// detail drawer), so the rename hook is gone.
const h = vi.hoisted(() => {
  const deleteMutate =
    vi.fn<(vars: { epicId: string }, opts?: { onSuccess?: () => void }) => void>();
  return {
    deleteMutate,
    del: { mutate: deleteMutate, isPending: false, isError: false, reset: vi.fn() },
  };
});

vi.mock('../hooks/useProductBacklog', () => ({
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
  h.del.isPending = false;
  h.del.isError = false;
  // Default: succeed immediately so the dialog closes on confirm.
  h.deleteMutate.mockImplementation((_vars, opts?: { onSuccess?: () => void }) =>
    opts?.onSuccess?.(),
  );
});

describe('EpicHeader edit affordance (#1346)', () => {
  it('a manager sees the epic name as a button that opens the detail drawer', async () => {
    const onOpen = vi.fn();
    render(<EpicHeader group={makeGroup()} projectId="p1" onOpen={onOpen} />);

    const nameBtn = screen.getByRole('button', { name: 'Edit epic Platform Core' });
    await userEvent.setup().click(nameBtn);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ id: 'EP1', name: 'Platform Core' });
  });

  it('a viewer (no canEdit) sees the name as plain text, not a button', () => {
    const onOpen = vi.fn();
    render(
      <EpicHeader
        group={makeGroup({ canEdit: false, canDelete: false })}
        projectId="p1"
        onOpen={onOpen}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit epic Platform Core' })).not.toBeInTheDocument();
    expect(screen.getByText('Platform Core')).toBeInTheDocument();
  });

  it('shows the selection ring while its drawer is open (selected)', () => {
    const { container, rerender } = render(
      <EpicHeader group={makeGroup()} projectId="p1" onOpen={vi.fn()} />,
    );
    // The header row is the first element child; unselected carries no ring.
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).not.toContain('ring-navy-700');

    rerender(<EpicHeader group={makeGroup()} projectId="p1" selected onOpen={vi.fn()} />);
    expect(row.className).toContain('ring-navy-700');
  });
});

describe('EpicHeader progress slot (#3210)', () => {
  it('draws the proportion once: bar named with the percentage, no numeral beside it', () => {
    render(
      <EpicHeader
        group={makeGroup({}, { storyCount: 2, pointsTotal: 8, pointsDone: 2 })}
        projectId="p1"
        onOpen={vi.fn()}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-label', 'Epic Platform Core: 2 of 8 points complete (25%)');
    expect(screen.getByText('2/8 pts')).toBeInTheDocument();
    expect(screen.queryByText(/25%/)).toBeNull();
  });

  it('bar is a tab stop, shows its tooltip on keyboard focus, and has no duplicate aria-describedby', () => {
    render(
      <EpicHeader
        group={makeGroup({}, { storyCount: 2, pointsTotal: 8, pointsDone: 2 })}
        projectId="p1"
        onOpen={vi.fn()}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('tabindex', '0');
    act(() => bar.focus());
    // aria-hidden panel (describe={false}): the bar's own name already says it.
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('25% complete · 2 of 8 pts');
    expect(bar).not.toHaveAttribute('aria-describedby');
  });

  it('marks a 100% epic with the completion outline, not color alone', () => {
    render(
      <EpicHeader
        group={makeGroup({}, { storyCount: 2, pointsTotal: 8, pointsDone: 8 })}
        projectId="p1"
        onOpen={vi.fn()}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('(100%)'));
    expect(bar.innerHTML + bar.className).toMatch(/outline/);
  });

  it('renders no progressbar at all when nothing is estimated', () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" onOpen={vi.fn()} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('img', { name: 'No points estimated' })).toBeInTheDocument();
  });
});

describe('EpicHeader kebab gating (#1346)', () => {
  it('a manager with canDelete gets a kebab whose only action is Delete', async () => {
    render(<EpicHeader group={makeGroup()} projectId="p1" onOpen={vi.fn()} />);
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /delete epic/i })).toBeInTheDocument();
    // Rename moved into the detail drawer — it is no longer a menu action.
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('a Product Owner (canEdit, NOT canDelete) can edit but sees no kebab', () => {
    render(<EpicHeader group={makeGroup({ canDelete: false })} projectId="p1" onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Edit epic Platform Core' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Epic actions: Platform Core' }),
    ).not.toBeInTheDocument();
  });

  it('a viewer (neither verdict) sees no kebab at all', () => {
    render(
      <EpicHeader
        group={makeGroup({ canEdit: false, canDelete: false })}
        projectId="p1"
        onOpen={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Epic actions: Platform Core' }),
    ).not.toBeInTheDocument();
  });
});

describe('EpicHeader delete (#1339)', () => {
  it('opens a confirmation naming the affected story count and deletes on confirm', async () => {
    render(
      <EpicHeader
        group={makeGroup({}, { storyCount: 3, pointsTotal: 0, pointsDone: 0 })}
        projectId="p1"
        onOpen={vi.fn()}
      />,
    );
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
    render(<EpicHeader group={makeGroup()} projectId="p1" onOpen={vi.fn()} />);
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /delete epic/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
