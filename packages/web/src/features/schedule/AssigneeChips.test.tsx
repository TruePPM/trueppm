import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AssigneeChips } from './AssigneeChips';
import type { TaskAssignee } from '@/types';

function makeAssignee(name: string, units = 1.0, resourceId = name): TaskAssignee {
  return { resourceId, name, units };
}

describe('AssigneeChips', () => {
  it('renders nothing when assignees is empty', () => {
    const { container } = render(<AssigneeChips assignees={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a chip for a single assignee', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice Chen')]} />);
    // Initials: A + C
    expect(screen.getByTitle('Alice Chen (100%)')).toBeInTheDocument();
    expect(screen.getByTitle('Alice Chen (100%)').textContent).toBe('AC');
  });

  it('renders two chips for exactly MAX_VISIBLE assignees (no overflow)', () => {
    const assignees = [makeAssignee('Alice Chen', 1.0, 'r1'), makeAssignee('Bob Martinez', 0.5, 'r2')];
    render(<AssigneeChips assignees={assignees} />);
    expect(screen.getByTitle('Alice Chen (100%)')).toBeInTheDocument();
    expect(screen.getByTitle('Bob Martinez (50%)')).toBeInTheDocument();
    // No +N overflow chip
    expect(screen.queryByTitle(/Carol/)).toBeNull();
  });

  it('renders +1 overflow chip when there are 3 assignees', () => {
    const assignees = [
      makeAssignee('Alice Chen', 1.0, 'r1'),
      makeAssignee('Bob Martinez', 1.0, 'r2'),
      makeAssignee('Carol Park', 1.0, 'r3'),
    ];
    render(<AssigneeChips assignees={assignees} />);
    // First two visible chips
    expect(screen.getByTitle('Alice Chen (100%)')).toBeInTheDocument();
    expect(screen.getByTitle('Bob Martinez (100%)')).toBeInTheDocument();
    // Overflow chip for 1 extra
    const overflowChip = screen.getByTitle('Carol Park');
    expect(overflowChip.textContent).toBe('+1');
  });

  it('renders +2 overflow chip when there are 4 assignees', () => {
    const assignees = [
      makeAssignee('Alice', 1.0, 'r1'),
      makeAssignee('Bob', 1.0, 'r2'),
      makeAssignee('Carol', 1.0, 'r3'),
      makeAssignee('David', 1.0, 'r4'),
    ];
    render(<AssigneeChips assignees={assignees} />);
    const overflowChip = screen.getByTitle('Carol, David');
    expect(overflowChip.textContent).toBe('+2');
  });

  it('extracts initials correctly for a single-word name', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice')]} />);
    expect(screen.getByTitle('Alice (100%)').textContent).toBe('A');
  });

  it('uses first and last initial for multi-word names', () => {
    render(<AssigneeChips assignees={[makeAssignee('John Michael Smith')]} />);
    // first[0]='J', last[0]='S'
    expect(screen.getByTitle('John Michael Smith (100%)').textContent).toBe('JS');
  });

  it('rounds units percentage correctly', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice', 0.333)]} />);
    // Math.round(0.333 * 100) = 33
    expect(screen.getByTitle('Alice (33%)')).toBeInTheDocument();
  });
});
