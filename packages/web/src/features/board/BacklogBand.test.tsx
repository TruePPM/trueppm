/**
 * BacklogBand unit tests — left-side rail variant (ADR-0057 rail layout).
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
import { BacklogBand, filterBacklogTasks, type BacklogBandProps } from './BacklogBand';
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

function renderBand(props: Partial<BacklogBandProps> & { tasks: Task[] }) {
  return render(
    <DndContext>
      <BacklogBand {...BASE_PROPS} {...props} />
    </DndContext>,
  );
}

/** Search is demoted (#1973): it renders only once the backlog crosses
 *  BACKLOG_SEARCH_MIN_IDEAS (8). Helper to generate enough padding ideas to
 *  cross the threshold without them matching a search term under test. */
function padIdeas(n: number): Task[] {
  return Array.from({ length: n }, (_, i) =>
    makeTask({ id: `pad-${i}`, name: `Padding idea ${i}` }),
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

  it('does not surface a stalled signal — backlog ideas are not committed work', () => {
    // Stalled is a commitment-progression concept (TO DO / IN PROGRESS / REVIEW
    // sitting too long). Backlog cards are uncommitted ideas; an old idea is
    // not a problem. Guards against the badge accidentally re-leaking.
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString();
    renderBand({
      tasks: [makeTask({ id: '1', name: 'Stale', statusEnteredAt: old })],
    });
    expect(screen.queryByLabelText(/stalled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stalled/i)).not.toBeInTheDocument();
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

  // --- Capture-first affordance (#1973) ---

  it('renders the capture field with a "+" affordance, captures on Enter, and clears the field', () => {
    const onQuickCapture = vi.fn();
    renderBand({ tasks: [], onQuickCapture });
    const input = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/Capture an idea/i));
    fireEvent.change(input, { target: { value: 'Refresh the logo' } });
    fireEvent.submit(input.closest('form')!);
    expect(onQuickCapture).toHaveBeenCalledWith('Refresh the logo', expect.any(Object));
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('restores the typed idea into the field when the create fails (#2030)', () => {
    // Simulate a failed create: invoke the onError the rail hands down. The rail
    // optimistically cleared the field on submit; onError must put the idea back
    // so a silent POST failure on the rapid-fire intake field never loses it.
    const onQuickCapture = vi.fn((_name: string, opts?: { onError?: () => void }) =>
      opts?.onError?.(),
    );
    renderBand({ tasks: [], onQuickCapture });
    const input = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    fireEvent.change(input, { target: { value: 'Refresh the logo' } });
    fireEvent.submit(input.closest('form')!);
    expect(onQuickCapture).toHaveBeenCalledWith('Refresh the logo', expect.any(Object));
    // The cleared field is repopulated with the lost idea.
    expect((input as HTMLInputElement).value).toBe('Refresh the logo');
  });

  it('does not clobber the next idea if the field was refilled before the error (#2030)', () => {
    // onError fires late (after the user started typing the next idea). The
    // restore is gated on the field still being empty, so it must NOT overwrite.
    let capturedOnError: (() => void) | undefined;
    const onQuickCapture = vi.fn((_name: string, opts?: { onError?: () => void }) => {
      capturedOnError = opts?.onError;
    });
    renderBand({ tasks: [], onQuickCapture });
    const input = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    fireEvent.change(input, { target: { value: 'First idea' } });
    fireEvent.submit(input.closest('form')!);
    // User has already started the next idea before the failure comes back.
    fireEvent.change(input, { target: { value: 'Second idea' } });
    capturedOnError?.();
    expect((input as HTMLInputElement).value).toBe('Second idea');
  });

  it('does not capture a blank or whitespace-only title', () => {
    const onQuickCapture = vi.fn();
    renderBand({ tasks: [], onQuickCapture });
    const input = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(onQuickCapture).not.toHaveBeenCalled();
  });

  it('does not render the capture field when no onQuickCapture handler is provided', () => {
    renderBand({ tasks: [makeTask()] });
    expect(
      screen.queryByRole('textbox', { name: /Capture a backlog idea/i }),
    ).not.toBeInTheDocument();
  });

  it('disables the capture field while a capture is pending', () => {
    renderBand({ tasks: [], onQuickCapture: vi.fn(), isQuickCapturePending: true });
    expect(screen.getByRole('textbox', { name: /Capture a backlog idea/i })).toBeDisabled();
  });

  it('points the empty state at the capture field when quick-capture is available', () => {
    renderBand({ tasks: [], onQuickCapture: vi.fn() });
    expect(screen.getByText(/capture an idea above/i)).toBeInTheDocument();
  });

  // --- Search, now demoted below the threshold (#1973) ---

  it('hides the search row below the threshold and shows it at/above it', () => {
    const { rerender } = renderBand({ tasks: padIdeas(7) });
    expect(screen.queryByRole('search', { name: /Search backlog/i })).not.toBeInTheDocument();
    rerender(
      <DndContext>
        <BacklogBand {...BASE_PROPS} tasks={padIdeas(8)} />
      </DndContext>,
    );
    expect(screen.getByRole('search', { name: /Search backlog/i })).toBeInTheDocument();
  });

  it('exposes the search row (≥8 ideas) as a search landmark with a real filter input', () => {
    renderBand({ tasks: padIdeas(8) });
    const search = screen.getByRole('search', { name: /Search backlog/i });
    expect(search).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: /Filter backlog ideas/i });
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/Search ideas/i));
  });

  it('filters the rail to matching cards as the user types (name match)', () => {
    renderBand({
      tasks: [
        makeTask({ id: 'a', name: 'Login rework' }),
        makeTask({ id: 'b', name: 'Export CSV' }),
        ...padIdeas(6),
      ],
    });
    expect(screen.getByText('Login rework')).toBeInTheDocument();
    expect(screen.getByText('Export CSV')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /Filter backlog ideas/i }), {
      target: { value: 'login' },
    });

    expect(screen.getByText('Login rework')).toBeInTheDocument();
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument();
  });

  it('matches on assignee name as well as card name', () => {
    renderBand({
      tasks: [
        makeTask({
          id: 'a',
          name: 'Untitled idea',
          assignees: [{ resourceId: 'r1', name: 'Sarah Lee', units: 1 }],
        }),
        makeTask({ id: 'b', name: 'Other idea', assignees: [] }),
        ...padIdeas(6),
      ],
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Filter backlog ideas/i }), {
      target: { value: 'sarah' },
    });
    expect(screen.getByText('Untitled idea')).toBeInTheDocument();
    expect(screen.queryByText('Other idea')).not.toBeInTheDocument();
  });

  it('shows a distinct no-match empty state and clears the query on "Clear search"', () => {
    renderBand({ tasks: [makeTask({ name: 'Login rework' }), ...padIdeas(7)] });
    fireEvent.change(screen.getByRole('textbox', { name: /Filter backlog ideas/i }), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText(/No ideas match/i)).toBeInTheDocument();
    // The base "No backlog yet" empty state must not be shown when tasks exist.
    expect(screen.queryByText(/No backlog yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Clear search/i }));
    expect(screen.getByText('Login rework')).toBeInTheDocument();
    expect(screen.queryByText(/No ideas match/i)).not.toBeInTheDocument();
  });

  it('renders a ⌘K handoff button that opens the command palette', () => {
    const onOpenCommandPalette = vi.fn();
    renderBand({ tasks: padIdeas(8), onOpenCommandPalette });
    const cmdk = screen.getByRole('button', { name: /command palette/i });
    fireEvent.click(cmdk);
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('calls onCaptureIdea when "Add with details…" is clicked', () => {
    const onCaptureIdea = vi.fn();
    renderBand({ tasks: [makeTask()], onCaptureIdea });
    const cta = screen.getByRole('button', { name: /Add with details/i });
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    expect(onCaptureIdea).toHaveBeenCalledTimes(1);
  });

  it('disables "Add with details…" while pending and shows "Adding…"', () => {
    renderBand({ tasks: [makeTask()], onCaptureIdea: vi.fn(), isCaptureIdeaPending: true });
    const cta = screen.getByRole('button', { name: /Adding/i });
    expect(cta).toBeDisabled();
  });

  it('disables "Add with details…" when no onCaptureIdea handler provided', () => {
    renderBand({ tasks: [makeTask()] });
    const cta = screen.getByRole('button', { name: /Add with details/i });
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

  it('full density renders age in plain "Nd ago" form (no stalled label) and shows "Project" when ungrouped', () => {
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
    expect(screen.getByText(/8d ago/)).toBeInTheDocument();
    expect(screen.queryByText(/stalled/i)).not.toBeInTheDocument();
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

  it('collapsed strip shows the rotated count without any stalled badge', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    renderBand({
      tasks: [makeTask({ statusEnteredAt: old })],
    });
    expect(screen.getByText(/Backlog · 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/stalled/i)).not.toBeInTheDocument();
  });

  it('focusing a card fires onCardFocus, clicking fires onCardClick with the task', () => {
    const onCardFocus = vi.fn();
    const onCardClick = vi.fn();
    renderBand({
      tasks: [makeTask({ id: 'idea-1', name: 'Spike auth flow', parentId: 'phase-x' })],
      onCardFocus,
      onCardClick,
    });
    const card = screen.getByRole('button', { name: /Spike auth flow, backlog idea/i });
    // Card is now @dnd-kit draggable, so pointer events belong to the drag
    // sensor. Keyboard-active tracking rides on the React focus event.
    fireEvent.focus(card);
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
    fireEvent.focus(screen.getByRole('button', { name: /backlog idea/i }));
    expect(onCardFocus).toHaveBeenCalledWith('free-idea', 'BACKLOG', 'root');
  });
});

describe('filterBacklogTasks (issue 1609)', () => {
  it('returns the list unchanged for an empty or whitespace query', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    expect(filterBacklogTasks(tasks, '')).toBe(tasks);
    expect(filterBacklogTasks(tasks, '   ')).toBe(tasks);
  });

  it('matches task names case-insensitively as a substring', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Login Rework' }),
      makeTask({ id: 'b', name: 'Export CSV' }),
    ];
    expect(filterBacklogTasks(tasks, 'LOG').map((t) => t.id)).toEqual(['a']);
    expect(filterBacklogTasks(tasks, 'csv').map((t) => t.id)).toEqual(['b']);
  });

  it('matches on assignee name', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Untitled', assignees: [{ resourceId: 'r1', name: 'Marcus Chen', units: 1 }] }),
      makeTask({ id: 'b', name: 'Untitled', assignees: [] }),
    ];
    expect(filterBacklogTasks(tasks, 'marcus').map((t) => t.id)).toEqual(['a']);
  });

  it('returns an empty array when nothing matches', () => {
    const tasks = [makeTask({ id: 'a', name: 'Login' })];
    expect(filterBacklogTasks(tasks, 'nonexistent')).toEqual([]);
  });
});
