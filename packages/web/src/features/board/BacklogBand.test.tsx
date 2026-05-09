/**
 * BacklogBand unit tests — left-side rail variant (epic #361 child A,
 * Claude Design rail layout).
 *
 * Cover the structural pieces the BoardView integration tests don't reach:
 *  - Header eyebrow + count copy (singular / plural)
 *  - Stalled-count badge fires only when at least one card is ≥ 5d old
 *  - Empty-state copy renders with no backlog cards
 *  - Collapsed state hides the body and renders the 44px vertical strip
 *  - Drop-target tint applies only when isOver && isDragActive
 *  - Cards sort by statusEnteredAt descending
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { BacklogBand } from './BacklogBand';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Idea',
    start: '2026-04-01',
    finish: '2026-04-02',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'BACKLOG',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

const BASE_PROPS = {
  isDragActive: false,
  isOver: false,
  phaseColorFor: () => '#1C6B3A',
  focusedCardId: null,
  onCardFocus: vi.fn(),
  onCardClick: vi.fn(),
};

function renderBand(props: Partial<typeof BASE_PROPS> & { tasks: Task[] }) {
  return render(
    <DndContext>
      <BacklogBand {...BASE_PROPS} {...props} />
    </DndContext>,
  );
}

beforeEach(() => {
  // Each test starts from an expanded rail — clear the persistence flag.
  localStorage.removeItem('trueppm.board.backlogBand.collapsed');
});

describe('BacklogBand (rail)', () => {
  it('renders the "Inbox · backlog" eyebrow', () => {
    renderBand({ tasks: [makeTask()] });
    expect(screen.getByText(/Inbox · backlog/i)).toBeInTheDocument();
  });

  it('shows count and singular "idea" copy for one card', () => {
    renderBand({ tasks: [makeTask({ name: 'A' })] });
    // The rail header marks the count as the heading; readiness chips share
    // the word "idea" so disambiguate via the heading aria-label.
    expect(screen.getByLabelText(/^1 idea in backlog$/i)).toBeInTheDocument();
  });

  it('shows plural "ideas" copy for multiple cards', () => {
    renderBand({
      tasks: [makeTask({ id: '1', name: 'A' }), makeTask({ id: '2', name: 'B' })],
    });
    expect(screen.getByLabelText(/^2 ideas in backlog$/i)).toBeInTheDocument();
  });

  it('renders empty-state copy when there are no backlog cards', () => {
    renderBand({ tasks: [] });
    expect(screen.getByText(/No backlog yet/)).toBeInTheDocument();
  });

  it('renders the drag hint copy when expanded', () => {
    renderBand({ tasks: [makeTask()] });
    expect(screen.getByText(/Drag right onto a phase/i)).toBeInTheDocument();
  });

  it('renders backlog card names', () => {
    renderBand({
      tasks: [
        makeTask({ id: '1', name: 'Refresh logo' }),
        makeTask({ id: '2', name: 'Audit links' }),
      ],
    });
    expect(screen.getByText('Refresh logo')).toBeInTheDocument();
    expect(screen.getByText('Audit links')).toBeInTheDocument();
  });

  it('shows the stalled badge when any card is at least 5 days old', () => {
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    renderBand({
      tasks: [
        makeTask({ id: '1', name: 'Stale', statusEnteredAt: old }),
        makeTask({ id: '2', name: 'Fresh', statusEnteredAt: new Date().toISOString() }),
      ],
    });
    expect(screen.getByLabelText(/^1 stalled$/i)).toBeInTheDocument();
  });

  it('does not show the stalled badge when nothing is older than 5 days', () => {
    renderBand({ tasks: [makeTask({ statusEnteredAt: new Date().toISOString() })] });
    expect(screen.queryByLabelText(/stalled$/i)).not.toBeInTheDocument();
  });

  it('collapses to the 44px vertical strip and hides cards', () => {
    renderBand({ tasks: [makeTask({ name: 'Card A' })] });
    expect(screen.getByText('Card A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse backlog rail' }));
    // Vertical strip exposes the count via its accessible name.
    expect(screen.getByRole('button', { name: /Expand backlog rail/i })).toBeInTheDocument();
    expect(screen.queryByText('Card A')).not.toBeInTheDocument();
  });

  it('applies drop-target tint only when dragging and isOver', () => {
    const { container, rerender } = renderBand({
      tasks: [makeTask()],
      isDragActive: true,
      isOver: true,
    });
    expect(container.querySelector('[data-testid="backlog-band"]')?.className)
      .toContain('bg-brand-primary/5');

    rerender(
      <DndContext>
        <BacklogBand {...BASE_PROPS} tasks={[makeTask()]} isDragActive={false} isOver={false} />
      </DndContext>,
    );
    expect(container.querySelector('[data-testid="backlog-band"]')?.className)
      .not.toContain('bg-brand-primary/5');
  });

  it('sorts cards by statusEnteredAt descending (most recent first)', () => {
    renderBand({
      tasks: [
        makeTask({ id: 'old', name: 'Old idea', statusEnteredAt: '2026-04-01T10:00Z' }),
        makeTask({ id: 'new', name: 'New idea', statusEnteredAt: '2026-04-05T10:00Z' }),
      ],
    });
    const cards = screen.getAllByRole('listitem');
    expect(cards[0]).toHaveTextContent('New idea');
    expect(cards[1]).toHaveTextContent('Old idea');
  });

  it('exposes the search row as a search landmark with the placeholder copy', () => {
    renderBand({ tasks: [makeTask()] });
    const search = screen.getByRole('search', { name: /Search backlog/i });
    expect(search).toHaveTextContent(/Search or capture an idea/i);
  });

  it('renders the disabled "Capture idea" CTA', () => {
    renderBand({ tasks: [makeTask()] });
    const cta = screen.getByRole('button', { name: /Capture idea/i });
    expect(cta).toBeDisabled();
  });

  it('renders compact density without phase line and shows phase dot + initials', () => {
    render(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          density="compact"
          tasks={[
            makeTask({
              name: 'Triage requests',
              assignees: [{ resourceId: 'r1', name: 'Sarah Lee', units: 1 }],
              priorityRank: 4,
            }),
          ]}
        />
      </DndContext>,
    );
    expect(screen.getByText('Triage requests')).toBeInTheDocument();
    expect(screen.queryByText(/Phase|Project/)).not.toBeInTheDocument();
  });

  it('full density renders priority + duration + age, "Phase" when parentId is set', () => {
    render(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          density="full"
          tasks={[
            makeTask({
              parentId: 'phase-a',
              priorityRank: 5,
              duration: 3,
              statusEnteredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            }),
          ]}
        />
      </DndContext>,
    );
    expect(screen.getByText('Phase')).toBeInTheDocument();
    expect(screen.getByText(/^P5$/)).toBeInTheDocument();
    expect(screen.getByText(/3d$/)).toBeInTheDocument();
    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
  });

  it('full density labels stalled cards distinctly and shows "Project" when ungrouped', () => {
    render(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          density="full"
          tasks={[
            makeTask({
              parentId: null,
              priorityRank: undefined,
              statusEnteredAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
            }),
          ]}
        />
      </DndContext>,
    );
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText(/^P—$/)).toBeInTheDocument();
    expect(screen.getByText(/8d · stalled/)).toBeInTheDocument();
  });

  it('renders the linked-dependency icon when predecessorCount > 0', () => {
    renderBand({
      tasks: [makeTask({ predecessorCount: 2, readiness: 'ready' })],
    });
    expect(screen.getByLabelText('Linked dependency')).toBeInTheDocument();
  });

  it('renders readiness "estimated" when an owner is set without dependencies', () => {
    renderBand({
      tasks: [
        makeTask({
          readiness: 'estimated',
          assignees: [{ resourceId: 'r1', name: 'Marcus Chen', units: 1 }],
        }),
      ],
    });
    // Readiness chip text matches the variant name.
    expect(screen.getByText(/^estimated$/)).toBeInTheDocument();
  });

  it('auto-expands a collapsed rail when a drag becomes active', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    const { rerender } = render(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          tasks={[makeTask({ name: 'Card A' })]}
          isDragActive={false}
          isOver={false}
        />
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Expand backlog rail/i })).toBeInTheDocument();
    expect(screen.queryByText('Card A')).not.toBeInTheDocument();

    rerender(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          tasks={[makeTask({ name: 'Card A' })]}
          isDragActive
          isOver={false}
        />
      </DndContext>,
    );
    expect(screen.getByText('Card A')).toBeInTheDocument();
  });

  it('shows the stalled-count badge on the collapsed strip', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    renderBand({
      tasks: [makeTask({ statusEnteredAt: old })],
    });
    expect(screen.getByLabelText(/^1 stalled$/i)).toBeInTheDocument();
  });

  it('clicking a card fires onCardFocus and onCardClick with the task', () => {
    const onCardFocus = vi.fn();
    const onCardClick = vi.fn();
    renderBand({
      tasks: [makeTask({ id: 'idea-1', name: 'Spike auth flow', parentId: 'phase-x' })],
      onCardFocus,
      onCardClick,
    });
    const card = screen.getByRole('button', { name: /Spike auth flow, backlog idea/i });
    fireEvent.pointerDown(card);
    expect(onCardFocus).toHaveBeenCalledWith('idea-1', 'BACKLOG', 'phase-x');
    fireEvent.click(card);
    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick.mock.calls[0][0]).toMatchObject({ id: 'idea-1' });
  });

  it('clicking the collapsed strip re-expands the rail', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    renderBand({ tasks: [makeTask({ name: 'Idea card' })] });
    expect(screen.queryByText('Idea card')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand backlog rail/i }));
    expect(screen.getByText('Idea card')).toBeInTheDocument();
  });

  it('falls back to "root" phase id when a backlog card has no parent', () => {
    const onCardFocus = vi.fn();
    renderBand({
      tasks: [makeTask({ id: 'free-idea', parentId: null })],
      onCardFocus,
    });
    fireEvent.pointerDown(screen.getByRole('button', { name: /backlog idea/i }));
    expect(onCardFocus).toHaveBeenCalledWith('free-idea', 'BACKLOG', 'root');
  });
});
