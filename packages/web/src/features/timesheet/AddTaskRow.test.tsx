import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AddTaskRow } from './AddTaskRow';

vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: vi.fn(),
}));
import { useMyWork } from '@/hooks/useMyWork';
const mockUseMyWork = useMyWork as ReturnType<typeof vi.fn>;

const TASKS = [
  { id: 't1', short_id: 'ENG-1', name: 'Build the grid', project_id: 'p1', project_name: 'Web' },
  { id: 't2', short_id: 'ENG-2', name: 'Wire the hook', project_id: 'p1', project_name: 'Web' },
];

beforeEach(() => {
  mockUseMyWork.mockReturnValue({
    data: { pages: [{ results: TASKS }] },
    isLoading: false,
  });
});

describe('AddTaskRow', () => {
  it('offers assigned tasks not already in the grid and reports the picked task', () => {
    const onAdd = vi.fn();
    render(<AddTaskRow existingTaskIds={new Set(['t2'])} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: /add project or task/i }));

    // t2 is already a row → excluded; t1 remains selectable.
    expect(screen.queryByText('Wire the hook')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /build the grid/i }));

    expect(onAdd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        taskId: 't1',
        taskShortId: 'ENG-1',
        taskName: 'Build the grid',
        projectId: 'p1',
        projectName: 'Web',
      }),
    );
  });

  it('excludes every task once they are all present as rows', () => {
    const onAdd = vi.fn();
    render(<AddTaskRow existingTaskIds={new Set(['t1', 't2'])} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: /add project or task/i }));
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});
