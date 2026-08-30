import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AssigneeChips, chipTitle, formatOwnerCellLabel } from './AssigneeChips';
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

/**
 * #3154 — allocation used to exist only in a `title`, which is nothing to a touch
 * user and nothing to a screen reader. These assert *rendered text* and
 * `toBeVisible()`, never `toHaveAttribute` alone: rule 328(b) is specifically that
 * an attribute is not a statement, so a test that reads the attribute would pass on
 * the broken build.
 */
describe('AssigneeChips — allocation is stated at rest (#3154)', () => {
  it('renders the percentage as visible text at size="md"', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice Chen', 0.5)]} size="md" max={3} />);
    expect(screen.getByText('50%')).toBeVisible();
  });

  it('renders one number per visible chip, in chip order, with a single trailing %', () => {
    const assignees = [
      makeAssignee('Alice Chen', 1.0, 'r1'),
      makeAssignee('Bob Martinez', 0.5, 'r2'),
    ];
    render(<AssigneeChips assignees={assignees} size="md" max={3} />);
    expect(screen.getByText('100/50%')).toBeVisible();
  });

  it('scopes the run to the rendered chips, not the overflowed assignees', () => {
    // 3 chips render and a "+1" summarises the rest, so the run pairs 1:1 with the
    // chips. The full per-assignee list stays reachable through the gridcell name.
    const assignees = [
      makeAssignee('Alice Chen', 1.0, 'r1'),
      makeAssignee('Bob Martinez', 0.5, 'r2'),
      makeAssignee('Carol Park', 0.25, 'r3'),
      makeAssignee('Dan Ruiz', 0.75, 'r4'),
    ];
    render(<AssigneeChips assignees={assignees} size="md" max={3} />);
    expect(screen.getByText('100/50/25%')).toBeVisible();
  });

  it('rounds the visible run through the same conversion as the title', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice', 0.333)]} size="md" max={3} />);
    expect(screen.getByText('33%')).toBeVisible();
  });

  it('hides the visible run from assistive tech — the gridcell name states it once', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice Chen', 0.5)]} size="md" max={3} />);
    expect(screen.getByText('50%')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders NO percentage text at size="sm" — the inline chips are unchanged', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice Chen', 0.5)]} size="sm" />);
    expect(screen.queryByText('50%')).toBeNull();
    // and the sm chip still carries its own per-chip tooltip
    expect(screen.getByTitle('Alice Chen (50%)')).toBeInTheDocument();
  });

  it('renders no percentage text at the default size (sm)', () => {
    render(<AssigneeChips assignees={[makeAssignee('Alice Chen', 0.5)]} />);
    expect(screen.queryByText('50%')).toBeNull();
  });
});

describe('formatOwnerCellLabel (#3154)', () => {
  it('states "Owner: none" for an unassigned task', () => {
    expect(formatOwnerCellLabel([])).toBe('Owner: none');
  });

  it('states each assignee with its units, using the chip formatter', () => {
    const assignees = [
      makeAssignee('Alice Chen', 1.0, 'r1'),
      makeAssignee('Bob Martinez', 0.5, 'r2'),
    ];
    expect(formatOwnerCellLabel(assignees)).toBe(
      `Owner: ${chipTitle(assignees[0])}, ${chipTitle(assignees[1])}`,
    );
    expect(formatOwnerCellLabel(assignees)).toBe('Owner: Alice Chen (100%), Bob Martinez (50%)');
  });

  it('names every assignee, including the ones the chips overflow', () => {
    const assignees = [
      makeAssignee('Alice Chen', 1.0, 'r1'),
      makeAssignee('Bob Martinez', 0.5, 'r2'),
      makeAssignee('Carol Park', 0.25, 'r3'),
      makeAssignee('Dan Ruiz', 0.75, 'r4'),
    ];
    expect(formatOwnerCellLabel(assignees)).toContain('Dan Ruiz (75%)');
  });
});
