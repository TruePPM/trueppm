import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskRow } from './TaskRow';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-05-01',
    finish: '2026-05-05',
    duration: 4,
    progress: 25,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

const baseProps = {
  rowIndex: 0,
  isSelected: false,
  isRenaming: false,
  onToggleSelect: vi.fn(),
  onStartRename: vi.fn(),
  onRename: vi.fn(),
  onCancelRename: vi.fn(),
};

describe('TaskRow', () => {
  it('renders the task name and the phase subtitle when phase is set', () => {
    const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('· Discovery')).toBeInTheDocument();
  });

  it('omits the phase subtitle when phase is the dash placeholder', () => {
    const task = makeTask({ id: 't1', wbs: '1' });
    render(<TaskRow {...baseProps} task={task} phase="—" />);
    expect(screen.queryByText('· —')).not.toBeInTheDocument();
  });

  it('shows the CP badge for critical tasks', () => {
    const task = makeTask({ id: 't1', wbs: '1.1', isCritical: true });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByLabelText('Critical path')).toBeInTheDocument();
  });

  it('does not show the CP badge for non-critical tasks', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.queryByLabelText('Critical path')).not.toBeInTheDocument();
  });

  it('renders the owner avatar when an assignee is present', () => {
    const task = makeTask({
      id: 't1',
      wbs: '1.1',
      assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
    });
    render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument();
  });

  it('omits the avatar when there is no assignee', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { container } = render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
    expect(container.querySelector('[aria-label="Alice"]')).toBeNull();
  });

  it('F2 invokes onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'F2' });
    expect(onStartRename).toHaveBeenCalled();
  });

  it('double-click on a leaf invokes onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).toHaveBeenCalled();
  });

  it('double-click on a summary does NOT invoke onStartRename', () => {
    const onStartRename = vi.fn();
    const task = makeTask({ id: 'p1', wbs: '1', isSummary: true });
    render(<TaskRow {...baseProps} task={task} phase="—" onStartRename={onStartRename} />);
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(onStartRename).not.toHaveBeenCalled();
  });

  it('Enter inside the rename input commits the new name', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Renamed');
  });

  it('Escape inside the rename input invokes onCancelRename', () => {
    const onCancelRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(
      <TaskRow {...baseProps} task={task} phase="—" isRenaming onCancelRename={onCancelRename} />,
    );
    fireEvent.keyDown(screen.getByLabelText('Rename task'), { key: 'Escape' });
    expect(onCancelRename).toHaveBeenCalled();
  });

  it('checkbox toggle invokes onToggleSelect', () => {
    const onToggleSelect = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" onToggleSelect={onToggleSelect} />);
    fireEvent.click(screen.getByLabelText(`Select ${task.name}`));
    expect(onToggleSelect).toHaveBeenCalled();
  });

  it('select checkbox carries an enlarged (WCAG 2.5.8) touch hit-area (#1703)', () => {
    // The 16px visual box is wrapped in a label with a transparent centered 44px
    // `before:` overlay, gated to below `md`, so touch users get a ≥24px target
    // without the dense desktop table changing.
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" />);
    const label = screen.getByLabelText(`Select ${task.name}`).closest('label');
    expect(label).not.toBeNull();
    expect(label?.className).toMatch(/before:h-11/);
    expect(label?.className).toMatch(/before:w-11/);
    expect(label?.className).toMatch(/md:before:hidden/);
  });

  it('renders a selected row with brand-primary styling and aria-selected', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isSelected />);
    expect(screen.getByRole('row')).toHaveAttribute('aria-selected', 'true');
  });

  it('reflects its 1-based grid position via aria-rowindex (#2204)', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" ariaRowIndex={3} />);
    expect(screen.getByRole('row')).toHaveAttribute('aria-rowindex', '3');
  });

  it('wraps the select checkbox in a gridcell so the row owns only cells (#2204)', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" />);
    const cell = screen.getByLabelText(`Select ${task.name}`).closest('[role="gridcell"]');
    expect(cell).not.toBeNull();
  });

  it('alternates row background for odd rowIndex', () => {
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { container } = render(<TaskRow {...baseProps} task={task} phase="—" rowIndex={1} />);
    expect(container.querySelector('.bg-neutral-surface-raised')).not.toBeNull();
  });

  it('blur with relatedTarget OUTSIDE the row commits the rename', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    const { unmount } = render(
      <>
        <TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />
        <button type="button" data-testid="outside">
          elsewhere
        </button>
      </>,
    );
    const input = screen.getByLabelText('Rename task');
    const outside = screen.getByTestId('outside');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.blur(input, { relatedTarget: outside });
    expect(onRename).toHaveBeenCalledWith('Renamed');
    unmount();
  });

  it('blur with relatedTarget INSIDE the same row does NOT commit', () => {
    const onRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(<TaskRow {...baseProps} task={task} phase="—" isRenaming onRename={onRename} />);
    const input = screen.getByLabelText('Rename task');
    const checkbox = screen.getByLabelText(`Select ${task.name}`);
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.blur(input, { relatedTarget: checkbox });
    expect(onRename).not.toHaveBeenCalled();
  });

  describe('row click-to-open detail (#1691)', () => {
    it('single click opens the task detail after the click-vs-dblclick delay', () => {
      vi.useFakeTimers();
      try {
        const onOpenDetail = vi.fn();
        const task = makeTask({ id: 't1', wbs: '1.1' });
        render(<TaskRow {...baseProps} task={task} phase="—" onOpenDetail={onOpenDetail} />);
        fireEvent.click(screen.getByRole('row'));
        expect(onOpenDetail).not.toHaveBeenCalled(); // still pending
        vi.advanceTimersByTime(220);
        expect(onOpenDetail).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('double-click renames and cancels the pending open', () => {
      vi.useFakeTimers();
      try {
        const onOpenDetail = vi.fn();
        const onStartRename = vi.fn();
        const task = makeTask({ id: 't1', wbs: '1.1' });
        render(
          <TaskRow
            {...baseProps}
            task={task}
            phase="—"
            onOpenDetail={onOpenDetail}
            onStartRename={onStartRename}
          />,
        );
        const row = screen.getByRole('row');
        fireEvent.click(row); // arms the open timer
        fireEvent.doubleClick(row); // clears it + renames
        vi.advanceTimersByTime(400);
        expect(onStartRename).toHaveBeenCalled();
        expect(onOpenDetail).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clicking the select checkbox does not open detail', () => {
      vi.useFakeTimers();
      try {
        const onOpenDetail = vi.fn();
        const task = makeTask({ id: 't1', wbs: '1.1' });
        render(<TaskRow {...baseProps} task={task} phase="—" onOpenDetail={onOpenDetail} />);
        fireEvent.click(screen.getByLabelText(`Select ${task.name}`));
        vi.advanceTimersByTime(400);
        expect(onOpenDetail).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('tapping the enlarged hit-area (label) does not open detail (#1703)', () => {
      // A tap that lands in the enlarged 44px overlay (target = the label, not the
      // 16px box) must select, never open the row — the label stops propagation and
      // the row guard treats `label` as an interactive control.
      vi.useFakeTimers();
      try {
        const onOpenDetail = vi.fn();
        const task = makeTask({ id: 't1', wbs: '1.1' });
        render(<TaskRow {...baseProps} task={task} phase="—" onOpenDetail={onOpenDetail} />);
        const label = screen.getByLabelText(`Select ${task.name}`).closest('label');
        fireEvent.click(label as HTMLElement);
        vi.advanceTimersByTime(400);
        expect(onOpenDetail).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('Enter opens detail (keyboard equivalent, no delay)', () => {
      const onOpenDetail = vi.fn();
      const task = makeTask({ id: 't1', wbs: '1.1' });
      render(<TaskRow {...baseProps} task={task} phase="—" onOpenDetail={onOpenDetail} />);
      fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter' });
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
    });

    it('does not open detail while renaming', () => {
      vi.useFakeTimers();
      try {
        const onOpenDetail = vi.fn();
        const task = makeTask({ id: 't1', wbs: '1.1' });
        render(
          <TaskRow {...baseProps} task={task} phase="—" isRenaming onOpenDetail={onOpenDetail} />,
        );
        // Click lands on the rename input (closest('input') guard) — no open.
        fireEvent.click(screen.getByLabelText('Rename task'));
        vi.advanceTimersByTime(400);
        expect(onOpenDetail).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is inert on click when onOpenDetail is not provided', () => {
      const task = makeTask({ id: 't1', wbs: '1.1' });
      render(<TaskRow {...baseProps} task={task} phase="—" />);
      // No throw, no cursor-pointer class, no interactive affordance name.
      const row = screen.getByRole('row');
      expect(row.className).not.toMatch(/cursor-pointer/);
      expect(row).not.toHaveAttribute('aria-label');
    });

    it('interactive row exposes an activation affordance (name + focus ring)', () => {
      const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
      render(<TaskRow {...baseProps} task={task} phase="—" onOpenDetail={vi.fn()} />);
      const row = screen.getByRole('row', { name: 'Open details for Build' });
      expect(row.className).toMatch(/cursor-pointer/);
      // Standalone focusable row uses focus: (not focus-visible:) so the ring shows
      // on pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7).
      expect(row.className).toMatch(/focus:ring-2/);
    });
  });

  it('keys other than Enter/Escape inside the rename input are ignored', () => {
    const onRename = vi.fn();
    const onCancelRename = vi.fn();
    const task = makeTask({ id: 't1', wbs: '1.1' });
    render(
      <TaskRow
        {...baseProps}
        task={task}
        phase="—"
        isRenaming
        onRename={onRename}
        onCancelRename={onCancelRename}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText('Rename task'), { key: 'a' });
    expect(onRename).not.toHaveBeenCalled();
    expect(onCancelRename).not.toHaveBeenCalled();
  });

  describe('responsive layout (#1701)', () => {
    it('wraps cells in two md:contents groups so the row reflows to a card on mobile', () => {
      const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
      const { container } = render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
      // The primary (WBS/name/owner) and secondary (dates/dur/progress/status)
      // groups collapse to `display: contents` at `md`+ so desktop is unchanged;
      // below `md` they stack into two lines.
      expect(container.querySelectorAll('[class*="md:contents"]').length).toBe(2);
    });

    it('uses a fixed mobile card height that matches the virtualiser estimate (h-14 → 56px)', () => {
      const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
      render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
      const row = screen.getByRole('row');
      // h-14 (mobile card, 56px) matches VirtualRows estimateSize on mobile so the
      // second line is never clipped; md:h-11 restores the desktop single-line row.
      expect(row.className).toContain('h-14');
      expect(row.className).toContain('md:h-11');
    });

    it('hides the phase subtitle on mobile to keep the name line uncluttered', () => {
      const task = makeTask({ id: 't1', wbs: '1.1', name: 'Build' });
      render(<TaskRow {...baseProps} task={task} phase="Discovery" />);
      const phase = screen.getByText('· Discovery');
      expect(phase.className).toContain('hidden');
      expect(phase.className).toContain('md:inline');
    });
  });
});
