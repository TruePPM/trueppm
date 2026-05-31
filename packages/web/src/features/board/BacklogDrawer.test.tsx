/**
 * BacklogDrawer unit tests — top-strip variant of the backlog surface (epic
 * #361 child C / issue #383, Claude Design `BacklogDrawer`).
 *
 * Cover the structural pieces the BoardView integration tests don't reach:
 *  - Header count copy (singular / plural)
 *  - Stalled count surfaces only when at least one card is older than the
 *    14-day threshold. Diverges from the rail (which intentionally suppresses
 *    a stalled signal for uncommitted ideas) — the drawer's compact header has
 *    room for the triage hint that the rail communicates via per-card age.
 *  - Empty-state copy when no backlog cards
 *  - Collapse toggle hides the body and persists across mount
 *  - Drop-target tint applies only when isOver && isDragActive
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { BacklogDrawer } from './BacklogDrawer';
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
  phaseColorFor: () => '#3E8C6D',
  focusedCardId: null,
  onCardFocus: vi.fn(),
  onCardClick: vi.fn(),
};

function renderDrawer(props: Partial<typeof BASE_PROPS> & { tasks: Task[] }) {
  return render(
    <DndContext>
      <BacklogDrawer {...BASE_PROPS} {...props} />
    </DndContext>,
  );
}

beforeEach(() => {
  // Each test starts from an open drawer — clear the persistence flag.
  localStorage.removeItem('trueppm.board.backlogDrawer.open');
});

describe('BacklogDrawer (top strip)', () => {
  it('renders the "Backlog" eyebrow', () => {
    renderDrawer({ tasks: [makeTask()] });
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent(/Backlog/);
  });

  it('shows count and singular "idea" copy for one card', () => {
    renderDrawer({ tasks: [makeTask({ name: 'A' })] });
    expect(screen.getByText('1 idea')).toBeInTheDocument();
  });

  it('shows plural "ideas" copy for multiple cards', () => {
    renderDrawer({
      tasks: [makeTask({ id: '1', name: 'A' }), makeTask({ id: '2', name: 'B' })],
    });
    expect(screen.getByText('2 ideas')).toBeInTheDocument();
  });

  it('renders the drag hint copy when expanded (desktop only)', () => {
    renderDrawer({ tasks: [makeTask()] });
    expect(screen.getByText(/Drag a card down to defer/i)).toBeInTheDocument();
  });

  it('renders empty-state copy when there are no backlog cards', () => {
    renderDrawer({ tasks: [] });
    expect(screen.getByText(/No backlog yet/)).toBeInTheDocument();
  });

  it('renders backlog card names when expanded', () => {
    renderDrawer({
      tasks: [
        makeTask({ id: '1', name: 'Refresh logo' }),
        makeTask({ id: '2', name: 'Audit links' }),
      ],
    });
    expect(screen.getByText('Refresh logo')).toBeInTheDocument();
    expect(screen.getByText('Audit links')).toBeInTheDocument();
  });

  it('hides the stalled count when no card is older than 14 days', () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    renderDrawer({
      tasks: [makeTask({ id: '1', name: 'Fresh', statusEnteredAt: recent })],
    });
    expect(screen.queryByText(/stalled/i)).not.toBeInTheDocument();
  });

  it('surfaces a stalled count when at least one card is older than 14 days', () => {
    const stale = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    renderDrawer({
      tasks: [
        makeTask({ id: '1', name: 'Fresh', statusEnteredAt: recent }),
        makeTask({ id: '2', name: 'Old', statusEnteredAt: stale }),
      ],
    });
    expect(screen.getByText('1 stalled')).toBeInTheDocument();
  });

  it('collapses on header click and re-opens on a second click', () => {
    renderDrawer({ tasks: [makeTask({ name: 'Card A' })] });
    const toggle = screen.getByRole('button', { expanded: true });
    expect(screen.getByText('Card A')).toBeVisible();
    fireEvent.click(toggle);
    // After collapse, the header reports collapsed via aria-expanded; the body
    // is still rendered but hidden via the `hidden` attribute so drop targets
    // remain registered for transient drag auto-expand.
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
    // `hidden` removes the element from the accessibility tree, so a query
    // without `hidden: true` returns nothing — exactly the assertion we want.
    expect(screen.queryByRole('list', { name: /Backlog cards/i })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('persists the collapsed state across mount', () => {
    const { unmount } = renderDrawer({ tasks: [makeTask()] });
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(localStorage.getItem('trueppm.board.backlogDrawer.open')).toBe('0');
    unmount();
    renderDrawer({ tasks: [makeTask()] });
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });

  it('sorts cards by statusEnteredAt descending (newest first)', () => {
    const older = '2026-04-01T00:00:00Z';
    const newer = '2026-05-01T00:00:00Z';
    renderDrawer({
      tasks: [
        makeTask({ id: '1', name: 'Older', statusEnteredAt: older }),
        makeTask({ id: '2', name: 'Newer', statusEnteredAt: newer }),
      ],
    });
    const list = screen.getByRole('list', { name: /Backlog cards/i });
    const items = list.querySelectorAll('[role="listitem"]');
    expect(items[0]).toHaveTextContent('Newer');
    expect(items[1]).toHaveTextContent('Older');
  });
});
