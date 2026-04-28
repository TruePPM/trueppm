/**
 * Tests for ResourceAssignmentSection — overallocation warning display (#97).
 */
import { screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { ResourceAssignmentSection } from './ResourceAssignmentSection';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Capture the onSuccess/onSettled callbacks so tests can invoke them directly.
type WarningPayload = { code: string; resource_id: string; resource_name: string; detail: string };
type MutateCallbacks = {
  onSuccess?: (result: { warnings: WarningPayload[] }) => void;
  onSettled?: () => void;
};
let capturedOnSuccess: MutateCallbacks['onSuccess'] | null = null;
let capturedOnSettled: MutateCallbacks['onSettled'] | null = null;
const mutateMock = vi.fn().mockImplementation((_payload: unknown, callbacks: MutateCallbacks) => {
  capturedOnSuccess = callbacks?.onSuccess ?? null;
  capturedOnSettled = callbacks?.onSettled ?? null;
});

const { addMutationMock, updateMutationMock, removeMutationMock } = vi.hoisted(() => ({
  addMutationMock: {
    mutate: vi.fn(),
    isPending: false,
  },
  updateMutationMock: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as { id: string } | undefined,
  },
  removeMutationMock: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as string | undefined,
  },
}));

vi.mock('@/hooks/useAssignmentMutations', () => ({
  useAddAssignment: () => ({ ...addMutationMock, mutate: mutateMock }),
  useUpdateAssignment: () => updateMutationMock,
  useRemoveAssignment: () => removeMutationMock,
}));

let mockAssignments: unknown[] = [];
let mockIsLoading = false;

vi.mock('@/hooks/useTaskAssignments', () => ({
  useTaskAssignments: () => ({ data: mockAssignments, isLoading: mockIsLoading }),
}));

vi.mock('./ResourceSearchCombobox', () => ({
  ResourceSearchCombobox: ({ onSelect, onDismiss }: { onSelect: (id: string, name: string) => void; onDismiss: () => void }) => (
    <div>
      <button onClick={() => onSelect('r1', 'Alice')}>Select Alice</button>
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSection(taskId = 'task-1', projectId = 'proj-1') {
  return renderWithProviders(
    <ResourceAssignmentSection taskId={taskId} projectId={projectId} />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourceAssignmentSection — overallocation warning (#97)', () => {
  beforeEach(() => {
    capturedOnSuccess = null;
    capturedOnSettled = null;
    mockAssignments = [];
    mockIsLoading = false;
    mutateMock.mockClear();
    updateMutationMock.mutate.mockClear();
    removeMutationMock.mutate.mockClear();
  });

  it('renders the section without a warning by default', () => {
    renderSection();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an overallocation warning after a successful add with a warning payload', () => {
    renderSection();

    // Open search and select a resource
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));

    // Simulate mutate onSuccess with an overallocation warning
    act(() => {
      capturedOnSuccess?.({
        warnings: [
          {
            code: 'resource_overallocated',
            resource_id: 'r1',
            resource_name: 'Alice',
            detail: 'Alice is allocated 150% across active tasks (capacity: 100%).',
          },
        ],
      });
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Alice is allocated 150%/i)).toBeInTheDocument();
  });

  it('does not show a warning when the add succeeds with no warnings', () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));

    act(() => { capturedOnSuccess?.({ warnings: [] }); });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dismisses the warning when the ✕ button is clicked', () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSuccess?.({
        warnings: [
          {
            code: 'resource_overallocated',
            resource_id: 'r1',
            resource_name: 'Alice',
            detail: 'Alice is allocated 150% across active tasks (capacity: 100%).',
          },
        ],
      });
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss overallocation warning/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a skill mismatch warning when add returns a skill_mismatch warning', () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));

    act(() => {
      capturedOnSuccess?.({
        warnings: [
          {
            code: 'skill_mismatch',
            resource_id: 'r1',
            resource_name: 'Alice',
            detail: 'Alice lacks the required Python skill.',
          },
        ],
      });
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/lacks the required Python skill/i)).toBeInTheDocument();
  });

  it('dismisses the skill mismatch warning when ✕ is clicked', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSuccess?.({
        warnings: [{ code: 'skill_mismatch', resource_id: 'r1', resource_name: 'Alice', detail: 'Mismatch.' }],
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss skill mismatch warning/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides search and restores focus button via onSettled callback', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    // Search is visible
    expect(screen.queryByRole('button', { name: /add resource/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSettled?.();
    });
    // After settled, search is hidden again
    expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument();
  });

  it('hides search when Dismiss button in combobox is clicked', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    expect(screen.queryByRole('button', { name: /add resource/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Dismiss$/i }));
    expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument();
  });

  it('renders the loading skeleton when isLoading is true', () => {
    mockIsLoading = true;
    mockAssignments = [];
    renderSection();
    // AssignmentSkeleton renders (actual pulse bars or aria-busy)
    expect(screen.queryByRole('button', { name: /add resource/i })).toBeInTheDocument();
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it('renders "None" when assignments is an empty array and not loading', () => {
    mockAssignments = [];
    renderSection();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('renders AssignmentRow for each assignment', () => {
    mockAssignments = [
      { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 1.0 },
    ];
    renderSection();
    // AssignmentRow is the real component so we can't easily query it by name,
    // but the section should render without crashing.
    expect(screen.getByRole('region', { name: /Resource Assignments/i })).toBeInTheDocument();
  });

  it('clears overallocation warning when the associated resource is removed', () => {
    mockAssignments = [
      { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 1.0 },
    ];
    renderSection();

    // Trigger an overallocation warning for resource r1
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSuccess?.({
        warnings: [{ code: 'resource_overallocated', resource_id: 'r1', resource_name: 'Alice', detail: 'Overloaded' }],
      });
    });
    act(() => { capturedOnSettled?.(); });

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Now remove the assignment — AssignmentRow's Remove button
    // AssignmentRow renders a remove button
    const removeBtn = screen.getByRole('button', { name: /remove/i });
    fireEvent.click(removeBtn);

    // Warning should be cleared after removing the assigned resource
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears skill mismatch warning when the associated resource is removed', () => {
    mockAssignments = [
      { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 1.0 },
    ];
    renderSection();

    // Trigger a skill mismatch warning for resource r1
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSuccess?.({
        warnings: [{ code: 'skill_mismatch', resource_id: 'r1', resource_name: 'Alice', detail: 'Missing skill' }],
      });
    });
    act(() => { capturedOnSettled?.(); });

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Remove the assignment
    const removeBtn = screen.getByRole('button', { name: /remove/i });
    fireEvent.click(removeBtn);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not clear warning when a different resource is removed', () => {
    mockAssignments = [
      { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 1.0 },
      { id: 'a2', resourceId: 'r2', resourceName: 'Bob', units: 1.0 },
    ];
    renderSection();

    // Trigger overallocation warning for r1
    fireEvent.click(screen.getByRole('button', { name: /add resource/i }));
    fireEvent.click(screen.getByRole('button', { name: /select alice/i }));
    act(() => {
      capturedOnSuccess?.({
        warnings: [{ code: 'resource_overallocated', resource_id: 'r1', resource_name: 'Alice', detail: 'Overloaded' }],
      });
    });
    act(() => { capturedOnSettled?.(); });

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Remove r2 (Bob) — warning should NOT be cleared since it's for r1
    const removeBtns = screen.getAllByRole('button', { name: /remove/i });
    // Click the second remove button (Bob's)
    fireEvent.click(removeBtns[1]);

    // Warning for r1 should still be visible
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('calls updateAssignment.mutate when onUnitsChange is triggered from AssignmentRow', () => {
    mockAssignments = [
      { id: 'a1', resourceId: 'r1', resourceName: 'Alice', units: 1.0 },
    ];
    renderSection();

    // Change the units input from 100 to 80
    const input = screen.getByLabelText(/allocation percent for Alice/i);
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.blur(input);

    expect(updateMutationMock.mutate).toHaveBeenCalledWith({ id: 'a1', units: 0.8 });
  });
});

