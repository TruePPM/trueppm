/**
 * QueueRow unit tests — table-style row in the Queue layout (epic #361 child D
 * / issue #384). Cover the visual atoms and inline affordances:
 *  - Italic + secondary tone for BACKLOG rows (idea treatment)
 *  - Standard tone + status badge for non-BACKLOG rows
 *  - Readiness chip vs. status badge swap based on status
 *  - CP / risk / milestone affordances render only when applicable
 *  - Phase tag renders the supplied name with a deterministic color dot
 *  - Owner avatar shows initials or the unassigned placeholder
 *  - Click invokes onClick with the row element as the anchor
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueRow } from './QueueLayout';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task A',
    start: '2026-04-01',
    finish: '2026-04-05',
    duration: 4,
    progress: 0,
    parentId: 'phase-1',
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

const BASE_PROPS = {
  phaseName: 'Discovery',
  phaseColor: '#3E8C6D',
  isFocused: false,
  onFocus: vi.fn(),
  onClick: vi.fn(),
};

describe('QueueRow', () => {
  it('renders the task name and phase tag', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ name: 'Refresh logo' })} />);
    expect(screen.getByText('Refresh logo')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
  });

  it('renders an italic, secondary-tone name for BACKLOG rows', () => {
    render(
      <QueueRow {...BASE_PROPS} task={makeTask({ status: 'BACKLOG', name: 'Idea X' })} />,
    );
    const name = screen.getByText('Idea X');
    expect(name.className).toMatch(/italic/);
    expect(name.className).toMatch(/text-neutral-text-secondary/);
  });

  it('renders the readiness chip for BACKLOG rows', () => {
    render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({ status: 'BACKLOG', readiness: 'ready' })}
      />,
    );
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('renders a status badge with progress for IN_PROGRESS rows', () => {
    render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({ status: 'IN_PROGRESS', progress: 42 })}
      />,
    );
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('hides the percent suffix for NOT_STARTED rows', () => {
    render(
      <QueueRow {...BASE_PROPS} task={makeTask({ status: 'NOT_STARTED', progress: 0 })} />,
    );
    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('renders the CP badge when the task is on the critical path', () => {
    render(
      <QueueRow {...BASE_PROPS} task={makeTask({ isCritical: true, isComplete: false })} />,
    );
    expect(screen.getByLabelText(/On the critical path/i)).toHaveTextContent('CP');
  });

  it('omits the CP badge when the task is complete (no longer at risk)', () => {
    render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({ isCritical: true, isComplete: true, status: 'COMPLETE' })}
      />,
    );
    expect(screen.queryByLabelText(/On the critical path/i)).toBeNull();
  });

  it('renders the risk glyph when linkedRisksCount > 0', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ linkedRisksCount: 3 })} />);
    expect(screen.getByLabelText('3 linked risks')).toBeInTheDocument();
  });

  it('renders the milestone glyph when isMilestone', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ isMilestone: true })} />);
    expect(screen.getByLabelText('Milestone')).toBeInTheDocument();
  });

  it('renders the duration suffix when > 0', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ duration: 7 })} />);
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  it('shows the unassigned avatar placeholder when there are no assignees', () => {
    const { container } = render(
      <QueueRow {...BASE_PROPS} task={makeTask({ assignees: [] })} />,
    );
    // The placeholder is a "?" glyph inside a dashed-border circle. It is
    // aria-hidden, so query by text content rather than role.
    expect(container.textContent).toContain('?');
  });

  it('shows initials avatar when an assignee is present', () => {
    const { container } = render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({
          assignees: [{ resourceId: 'r1', name: 'Alex Kim', units: 1 }],
        })}
      />,
    );
    expect(container.textContent).toContain('AK');
  });

  it('invokes onClick with the button element as anchor', () => {
    const onClick = vi.fn();
    render(<QueueRow {...BASE_PROPS} onClick={onClick} task={makeTask()} />);
    // The row-open button is named after the task; the sibling overflow trigger
    // ("Actions for …") is a second button, so disambiguate by accessible name.
    const button = screen.getByRole('button', { name: /^Task A,/ });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toBe(button);
  });

  it('invokes onFocus when the row gains focus', () => {
    const onFocus = vi.fn();
    render(<QueueRow {...BASE_PROPS} onFocus={onFocus} task={makeTask()} />);
    screen.getByRole('button', { name: /^Task A,/ }).focus();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('derives two-letter initials from a single-word assignee name', () => {
    const { container } = render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({ assignees: [{ resourceId: 'r1', name: 'Cher', units: 1 }] })}
      />,
    );
    // Single token → first two characters, upper-cased.
    expect(container.textContent).toContain('CH');
  });

  it('renders the singular risk label when exactly one risk is linked', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ linkedRisksCount: 1 })} />);
    expect(screen.getByLabelText('1 linked risk')).toBeInTheDocument();
    // Not the plural form.
    expect(screen.queryByLabelText('1 linked risks')).toBeNull();
  });

  it('renders a status badge with progress for REVIEW rows', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ status: 'REVIEW', progress: 88 })} />);
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('88%')).toBeInTheDocument();
  });

  it('shows the completed status badge with 100% progress for COMPLETE rows', () => {
    render(
      <QueueRow
        {...BASE_PROPS}
        task={makeTask({ status: 'COMPLETE', progress: 100, isComplete: true })}
      />,
    );
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('applies the focus ring class when the row is the focused card', () => {
    render(<QueueRow {...BASE_PROPS} isFocused task={makeTask()} />);
    const button = screen.getByRole('button', { name: /^Task A,/ });
    expect(button.className).toMatch(/ring-brand-primary/);
  });

  it('omits the focus ring class when the row is not focused', () => {
    render(<QueueRow {...BASE_PROPS} isFocused={false} task={makeTask()} />);
    const button = screen.getByRole('button', { name: /^Task A,/ });
    // The base button always has focus-visible ring utilities; the persistent
    // (non focus-visible) `ring-2 ring-brand-primary ring-inset` string is what
    // the focused state adds — absent here means only one ring-inset occurrence.
    const inset = button.className.match(/ring-inset/g) ?? [];
    expect(inset).toHaveLength(1);
  });

  it('labels the priority histogram with the rank when one is set', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ priorityRank: 5 })} />);
    expect(screen.getByTitle('Priority 5')).toBeInTheDocument();
  });

  it('labels the priority histogram "No priority" when the rank is undefined', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ priorityRank: undefined })} />);
    expect(screen.getByTitle('No priority')).toBeInTheDocument();
  });

  it('omits the duration suffix when duration is zero (milestone-like row)', () => {
    render(<QueueRow {...BASE_PROPS} task={makeTask({ duration: 0 })} />);
    expect(screen.queryByText('0d')).toBeNull();
  });
});
