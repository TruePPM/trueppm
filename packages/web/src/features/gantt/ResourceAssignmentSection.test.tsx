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

// Capture the onSuccess callback so tests can invoke it directly.
let capturedOnSuccess: ((result: { warnings: { code: string; resource_id: string; resource_name: string; detail: string }[] }) => void) | null = null;
const mutateMock = vi.fn().mockImplementation((_payload, callbacks) => {
  capturedOnSuccess = callbacks?.onSuccess ?? null;
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

vi.mock('@/hooks/useTaskAssignments', () => ({
  useTaskAssignments: () => ({ data: [], isLoading: false }),
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
    mutateMock.mockClear();
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
});
