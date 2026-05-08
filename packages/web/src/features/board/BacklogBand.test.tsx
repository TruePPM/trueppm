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
});
