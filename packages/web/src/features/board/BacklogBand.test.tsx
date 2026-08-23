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
import { act, render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import {
  ageInDays,
  BacklogBand,
  BacklogCard,
  filterBacklogTasks,
  type BacklogBandProps,
} from './BacklogBand';
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

  // #2207: PriorityDot is aria-hidden (color-only), so the rank is folded into
  // the card's accessible name for SR users.
  it('folds priority rank into the backlog card accessible name', () => {
    renderBand({ tasks: [makeTask({ name: 'Rework', priorityRank: 4 })] });
    expect(
      screen.getByRole('button', { name: 'Rework, backlog idea, priority 4' }),
    ).toBeInTheDocument();
  });

  it('omits the priority suffix from the card name when unranked', () => {
    renderBand({ tasks: [makeTask({ name: 'Rework' })] });
    expect(screen.getByRole('button', { name: 'Rework, backlog idea' })).toBeInTheDocument();
  });

  it('renders empty-state copy when there are no backlog cards', () => {
    renderBand({ tasks: [] });
    expect(screen.getByText(/No backlog yet/)).toBeInTheDocument();
  });

  it('names the File under… action in the hint, and the drag second (#2952)', () => {
    renderBand({
      tasks: [makeTask()],
      fileUnderTargets: [{ id: 'phase-1', name: 'Discovery' }],
      onFileUnder: vi.fn(),
    });
    const hint = screen.getByText(/promotes it to/i);
    // The hint used to name ONLY the drag — the one path a keyboard user and a
    // phone user cannot take, on the surface whose whole job is promotion.
    expect(hint).toHaveTextContent('File under…');
    expect(hint).toHaveTextContent(/Dragging it right onto a phase does the same/i);
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

  // #2208 / WCAG 2.5.5 rule 5: the 24px rail-collapse control carries an
  // invisible before-pad so its touch target reaches 44px.
  it('gives the rail-collapse control a 44px touch target via before-pad', () => {
    renderBand({ tasks: [makeTask({ name: 'Card A' })] });
    const cls = screen.getByRole('button', { name: 'Collapse backlog rail' }).className;
    expect(cls).toContain('relative');
    expect(cls).toContain("before:inset-[-10px]");
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

  // --- Read-only rail (#2146) ---

  it('suppresses the quick-capture field when readOnly', () => {
    renderBand({
      tasks: [],
      onQuickCapture: vi.fn(),
      readOnly: true,
    });
    // A Viewer (or closed sprint) sees no authoring affordances on the rail.
    expect(
      screen.queryByRole('textbox', { name: /Capture a backlog idea/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the quick-capture field when not readOnly', () => {
    renderBand({
      tasks: [],
      onQuickCapture: vi.fn(),
    });
    expect(screen.getByRole('textbox', { name: /Capture a backlog idea/i })).toBeInTheDocument();
  });

  // --- The one field, and only one (#2952) ---

  it('offers no second creation form beside the capture field', () => {
    renderBand({ tasks: [makeTask()], onQuickCapture: vi.fn() });
    // "Add with details…" opened TaskFormModal with a BACKLOG default — a
    // richer form directly under a field that already captures. An inbox
    // catches an item with no place yet; a description and an assignee are
    // answers it does not have.
    expect(screen.queryByRole('button', { name: /Add with details/i })).not.toBeInTheDocument();
  });

  // --- Drag guard (#2680) — the read-only rail must also disable drag, not
  // just suppress the capture affordances above. Exercised per the three
  // cases the issue named: a Viewer, a closed-sprint Member, and an allowed
  // role (both map to a `readOnly` boolean by the time they reach the rail —
  // see useBoardIdentity.test.ts for the role/sprint matrix that produces it).

  it('a Viewer or closed-sprint Member (readOnly) cannot drag a backlog card', () => {
    renderBand({ tasks: [makeTask()], readOnly: true });
    const card = screen.getByRole('button', { name: /Idea, backlog idea/i });
    // dnd-kit's `attributes` (dropped here) are what carry this marker; its
    // absence proves the drag activator was never wired up, mirroring
    // BoardCard's readOnly handling (#2146).
    expect(card).not.toHaveAttribute('aria-roledescription', 'draggable');
    expect(card.className).toContain('cursor-default');
    expect(card.className).not.toContain('cursor-grab');
    // Never aria-disabled — the card stays click-to-open (#2146 pattern).
    expect(card).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('an allowed role (not readOnly) can still drag a backlog card', () => {
    renderBand({ tasks: [makeTask()], readOnly: false });
    const card = screen.getByRole('button', { name: /Idea, backlog idea/i });
    expect(card).toHaveAttribute('aria-roledescription', 'draggable');
    expect(card.className).toContain('cursor-grab');
    expect(card.className).not.toContain('cursor-default');
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

  it('makes the capture field read-only — never disabled — while a capture is pending', () => {
    renderBand({ tasks: [], onQuickCapture: vi.fn(), isQuickCapturePending: true });
    // A disabled element is blurred by the browser, which drops the caret (and
    // the soft keyboard on touch) between every idea — the opposite of the
    // rapid successive intake this field exists for (#2952). `submitCapture`
    // already refuses while pending, so nothing double-fires.
    const field = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    expect(field).toHaveAttribute('readonly');
    expect(field).not.toBeDisabled();
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

    // #2208 / WCAG 2.5.5 rule 5: the 16px clear-search glyph carries an
    // invisible before-pad so its touch target reaches 44px.
    const clearCls = screen.getByRole('button', { name: 'Clear backlog search' }).className;
    expect(clearCls).toContain('relative');
    expect(clearCls).toContain("before:inset-[-14px]");

    fireEvent.click(screen.getByRole('button', { name: /Clear search/i }));
    expect(screen.getByText('Login rework')).toBeInTheDocument();
    expect(screen.queryByText(/No ideas match/i)).not.toBeInTheDocument();
  });

  // #2208 / WCAG 2.5.5 rule 5: the 24px backlog-card `···` schedule action
  // carries an invisible before-pad so its touch target reaches 44px.
  it('gives the backlog-card schedule action a 44px touch target via before-pad', () => {
    render(
      <BacklogCard
        task={makeTask({ name: 'Spike auth flow' })}
        density="comfortable"
        phaseColor="#3E8C6D"
        ageDays={null}
        isFocused={false}
        onFocus={vi.fn()}
        onClick={vi.fn()}
        onSchedule={vi.fn()}
      />,
    );
    const cls = screen.getByRole('button', { name: 'Actions for Spike auth flow' }).className;
    expect(cls).toContain("before:inset-[-10px]");
  });

  it('renders a ⌘K handoff button that opens the command palette', () => {
    const onOpenCommandPalette = vi.fn();
    renderBand({ tasks: padIdeas(8), onOpenCommandPalette });
    const cmdk = screen.getByRole('button', { name: /command palette/i });
    fireEvent.click(cmdk);
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// ageInDays — the rail's "Nd ago" age stamp. Guards the three null paths so a
// clock skew or a missing timestamp never renders "NaNd ago" on a card.
// ---------------------------------------------------------------------------

describe('ageInDays', () => {
  it('returns null when the task has no statusEnteredAt', () => {
    expect(ageInDays(undefined)).toBeNull();
  });

  it('returns null for an unparseable timestamp rather than NaN', () => {
    expect(ageInDays('not-a-date')).toBeNull();
  });

  it('returns null for a future timestamp (clock skew is not a negative age)', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(ageInDays(tomorrow)).toBeNull();
  });

  it('floors the elapsed time to whole days', () => {
    // 3 days and change → 3, never 4.
    const past = new Date(Date.now() - (3 * 86_400_000 + 3_600_000)).toISOString();
    expect(ageInDays(past)).toBe(3);
  });

  it('returns 0 for a timestamp captured moments ago', () => {
    expect(ageInDays(new Date(Date.now() - 1_000).toISOString())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage — persistence failure, card atoms, compact density, the
// `···` schedule action, and the pending-capture guard.
// ---------------------------------------------------------------------------

describe('BacklogBand — collapsed-state persistence failures', () => {
  it('falls back to expanded when reading the preference throws (private mode)', () => {
    // A read error must never hide the rail: a card that looks lost is worse
    // than a forgotten preference.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      renderBand({ tasks: [makeTask({ name: 'Visible idea' })] });
      expect(screen.getByText('Visible idea')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Collapse backlog rail' })).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('still collapses when writing the preference throws (quota exceeded)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      renderBand({ tasks: [makeTask({ name: 'Card A' })] });
      fireEvent.click(screen.getByRole('button', { name: 'Collapse backlog rail' }));
      // The in-session collapse is honored even though it could not be persisted.
      expect(screen.getByRole('button', { name: /Expand backlog rail/i })).toBeInTheDocument();
      expect(screen.queryByText('Card A')).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('BacklogBand — owner initials', () => {
  it('uses the first two characters of a single-word assignee name', () => {
    renderBand({
      tasks: [
        makeTask({
          name: 'Mononym idea',
          assignees: [{ resourceId: 'r1', name: 'Prince', units: 1 }],
        }),
      ],
    });
    expect(screen.getByText('PR')).toBeInTheDocument();
  });

  it('uses first + last initials for a multi-word assignee name', () => {
    renderBand({
      tasks: [
        makeTask({
          name: 'Two-name idea',
          assignees: [{ resourceId: 'r1', name: 'Sarah  Lee', units: 1 }],
        }),
      ],
    });
    expect(screen.getByText('SL')).toBeInTheDocument();
  });

  it('renders the unassigned placeholder when a card has no assignee', () => {
    renderBand({ tasks: [makeTask({ name: 'Unowned idea', assignees: [] })] });
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});

describe('BacklogBand — priority histogram tone', () => {
  it('lights no bars and reads "No priority" when the card is unranked', () => {
    renderBand({ tasks: [makeTask({ name: 'Unranked', priorityRank: undefined })] });
    const dot = screen.getByTitle('No priority');
    const bars = Array.from(dot.children).map((c) => c.className);
    expect(bars).toHaveLength(3);
    bars.forEach((cls) => expect(cls).toBe('bg-neutral-border'));
  });

  it('uses the quiet secondary tone (not an alarm color) for a mid rank of 3', () => {
    renderBand({ tasks: [makeTask({ name: 'Mid', priorityRank: 3 })] });
    const dot = screen.getByTitle('Priority 3');
    const bars = Array.from(dot.children).map((c) => c.className);
    // rank 3 lights only the shortest bar (r >= 2), in the neutral tone.
    expect(bars[0]).toBe('bg-neutral-text-secondary');
    expect(bars[1]).toBe('bg-neutral-border');
    expect(bars[2]).toBe('bg-neutral-border');
  });

  it('escalates to the critical tone at rank 5', () => {
    renderBand({ tasks: [makeTask({ name: 'Urgent', priorityRank: 5 })] });
    const bars = Array.from(screen.getByTitle('Priority 5').children).map((c) => c.className);
    // rank 5 lights the two shorter bars (r >= 2, r >= 4); the tallest needs 6.
    expect(bars[0]).toBe('bg-semantic-critical');
    expect(bars[1]).toBe('bg-semantic-critical');
    expect(bars[2]).toBe('bg-neutral-border');
  });
});

describe('BacklogBand — focus ring', () => {
  it('rings the focused card and leaves the others unringed', () => {
    renderBand({
      tasks: [
        makeTask({ id: 'a', name: 'Focused idea' }),
        makeTask({ id: 'b', name: 'Other idea' }),
      ],
      focusedCardId: 'a',
    });
    expect(
      screen.getByRole('button', { name: /Focused idea, backlog idea/ }).className,
    ).toContain('ring-2');
    expect(
      screen.getByRole('button', { name: /Other idea, backlog idea/ }).className,
    ).not.toContain('ring-2');
  });
});

describe('BacklogCard — the ··· schedule action (#318)', () => {
  it('hands the task and its own trigger element to onSchedule', () => {
    const onSchedule = vi.fn<(task: Task, trigger: HTMLElement) => void>();
    renderBand({ tasks: [makeTask({ id: 'idea-9', name: 'Spike auth flow' })], onSchedule });
    const action = screen.getByRole('button', { name: 'Actions for Spike auth flow' });
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule…' }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(onSchedule.mock.calls[0][0]).toMatchObject({ id: 'idea-9' });
    // The ··· trigger — not the menuitem, which unmounts with the menu — is
    // handed back so the dialog can return focus somewhere that still exists.
    expect(onSchedule.mock.calls[0][1]).toBe(action);
  });

  it('does not open the card detail when the ··· action is clicked', () => {
    const onCardClick = vi.fn();
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      onSchedule: vi.fn(),
      onCardClick,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spike auth flow' }));
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('swallows pointerdown so pressing ··· never starts a card drag', () => {
    const onParentPointerDown = vi.fn();
    render(
      <DndContext>
        <div onPointerDown={onParentPointerDown}>
          <BacklogCard
            task={makeTask({ name: 'Spike auth flow' })}
            density="comfortable"
            phaseColor="#3E8C6D"
            ageDays={null}
            isFocused={false}
            onFocus={vi.fn()}
            onClick={vi.fn()}
            onSchedule={vi.fn()}
          />
        </div>
      </DndContext>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Spike auth flow' }));
    expect(onParentPointerDown).not.toHaveBeenCalled();
  });

  it('omits the ··· action entirely when no onSchedule handler is supplied', () => {
    renderBand({ tasks: [makeTask({ name: 'Spike auth flow' })] });
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });
});

describe('BacklogCard — drag feedback', () => {
  function renderDraggable(density: 'compact' | 'comfortable') {
    render(
      <DndContext>
        <BacklogCard
          task={makeTask({ name: 'Drag me' })}
          density={density}
          phaseColor="#3E8C6D"
          ageDays={null}
          isFocused={false}
          onFocus={vi.fn()}
          onClick={vi.fn()}
        />
      </DndContext>,
    );
    return screen.getByRole('button', { name: /Drag me, backlog idea/ });
  }

  it('dims the card once a keyboard drag picks it up', () => {
    const card = renderDraggable('comfortable');
    expect(card.className).not.toContain('opacity-60');
    // Space picks the card up (dnd-kit keyboard sensor).
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
    expect(card.className).toContain('opacity-60');
  });

  it('dims a compact card the same way', () => {
    const card = renderDraggable('compact');
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
    expect(card.className).toContain('opacity-60');
  });
});

describe('BacklogBand — compact density', () => {
  function renderCompact(props: Partial<BacklogBandProps> & { tasks: Task[] }) {
    return render(
      <DndContext>
        <BacklogBand {...BASE_PROPS} density="compact" {...props} />
      </DndContext>,
    );
  }

  it('folds the priority rank into a compact card name and omits it when unranked', () => {
    renderCompact({
      tasks: [
        makeTask({ id: 'a', name: 'Ranked', priorityRank: 2 }),
        makeTask({ id: 'b', name: 'Unranked' }),
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Ranked, backlog idea, priority 2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unranked, backlog idea' })).toBeInTheDocument();
  });

  it('opens the card detail when a compact card is clicked', () => {
    const onCardClick = vi.fn();
    renderCompact({ tasks: [makeTask({ id: 'c1', name: 'Triage requests' })], onCardClick });
    fireEvent.click(screen.getByRole('button', { name: /Triage requests, backlog idea/ }));
    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick.mock.calls[0][0]).toMatchObject({ id: 'c1' });
  });

  it('renders the ··· schedule action on compact cards and reserves room for it', () => {
    const onSchedule = vi.fn<(task: Task, trigger: HTMLElement) => void>();
    renderCompact({ tasks: [makeTask({ name: 'Triage requests' })], onSchedule });
    const card = screen.getByRole('button', { name: /Triage requests, backlog idea/ });
    // Right padding keeps the title clear of the absolutely-positioned action.
    expect(card.className).toContain('pr-7');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Triage requests' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule…' }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  it('drops the reserved padding when there is no ··· action', () => {
    renderCompact({ tasks: [makeTask({ name: 'Triage requests' })] });
    expect(
      screen.getByRole('button', { name: /Triage requests, backlog idea/ }).className,
    ).not.toContain('pr-7');
  });

  it('renders an unrefined idea in the italic idea tone and a groomed one in primary text', () => {
    renderCompact({
      tasks: [
        makeTask({ id: 'a', name: 'Raw idea', readiness: 'idea' }),
        makeTask({ id: 'b', name: 'Groomed idea', readiness: 'ready' }),
      ],
    });
    expect(screen.getByText('Raw idea').className).toContain('italic');
    expect(screen.getByText('Groomed idea').className).not.toContain('italic');
    expect(screen.getByText('Groomed idea').className).toContain('text-neutral-text-primary');
  });

  // Drag guard (#2680) applies identically in the compact render branch — it
  // has its own `{...dragProps}` spread, so it needs its own coverage.
  it('drops the drag activator on a compact card when readOnly', () => {
    renderCompact({ tasks: [makeTask({ name: 'Triage requests' })], readOnly: true });
    const card = screen.getByRole('button', { name: /Triage requests, backlog idea/ });
    expect(card).not.toHaveAttribute('aria-roledescription', 'draggable');
    expect(card.className).toContain('cursor-default');
  });
});

describe('BacklogBand — sort stability', () => {
  it('keeps the most recent idea on top regardless of the incoming order', () => {
    // Three cards force the comparator through both orderings (a<b and a>b).
    renderBand({
      tasks: [
        makeTask({ id: 'mid', name: 'Mid idea', statusEnteredAt: '2026-04-03T10:00Z' }),
        makeTask({ id: 'old', name: 'Old idea', statusEnteredAt: '2026-04-01T10:00Z' }),
        makeTask({ id: 'new', name: 'New idea', statusEnteredAt: '2026-04-05T10:00Z' }),
      ],
    });
    const cards = screen.getAllByRole('listitem');
    expect(cards[0]).toHaveTextContent('New idea');
    expect(cards[1]).toHaveTextContent('Mid idea');
    expect(cards[2]).toHaveTextContent('Old idea');
  });

  it('treats cards with an equal timestamp as ties and keeps them both', () => {
    renderBand({
      tasks: [
        makeTask({ id: 'a', name: 'Tie A', statusEnteredAt: '2026-04-03T10:00Z' }),
        makeTask({ id: 'b', name: 'Tie B', statusEnteredAt: '2026-04-03T10:00Z' }),
      ],
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('BacklogBand — quick capture while a create is in flight', () => {
  /** Type a title, then flip the rail into its pending state. */
  function renderPendingWithDraft(onQuickCapture: BacklogBandProps['onQuickCapture']) {
    const { rerender } = render(
      <DndContext>
        <BacklogBand {...BASE_PROPS} tasks={[]} onQuickCapture={onQuickCapture} />
      </DndContext>,
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /Capture a backlog idea/i,
    });
    fireEvent.change(input, { target: { value: 'Refresh the logo' } });
    rerender(
      <DndContext>
        <BacklogBand
          {...BASE_PROPS}
          tasks={[]}
          onQuickCapture={onQuickCapture}
          isQuickCapturePending
        />
      </DndContext>,
    );
    return input;
  }

  it('swaps the ⏎ affordance for a busy glyph while the create is in flight', () => {
    const input = renderPendingWithDraft(vi.fn());
    expect(input.value).toBe('Refresh the logo');
    expect(screen.getByText('…')).toBeInTheDocument();
    expect(screen.queryByText('⏎')).not.toBeInTheDocument();
  });

  it('ignores a second submit while the first create is still in flight', () => {
    const onQuickCapture = vi.fn();
    const input = renderPendingWithDraft(onQuickCapture);
    fireEvent.submit(input.closest('form')!);
    // No duplicate POST, and the typed idea is left intact rather than cleared.
    expect(onQuickCapture).not.toHaveBeenCalled();
    expect(input.value).toBe('Refresh the logo');
  });

  it('shows the ⏎ affordance once a draft is typed and no create is pending', () => {
    renderBand({ tasks: [], onQuickCapture: vi.fn() });
    const input = screen.getByRole('textbox', { name: /Capture a backlog idea/i });
    expect(screen.queryByText('⏎')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Refresh the logo' } });
    expect(screen.getByText('⏎')).toBeInTheDocument();
  });
});

describe('BacklogBand — search row controls', () => {
  it('keeps the filter applied when the search form is submitted with Enter', () => {
    renderBand({ tasks: [makeTask({ id: 'a', name: 'Login rework' }), ...padIdeas(7)] });
    const input = screen.getByRole('textbox', { name: /Filter backlog ideas/i });
    fireEvent.change(input, { target: { value: 'login' } });
    fireEvent.submit(input.closest('form')!);
    // Submitting must not navigate or reset the rail — the filter survives.
    expect(screen.getByText('Login rework')).toBeInTheDocument();
    expect(screen.queryByText('Padding idea 0')).not.toBeInTheDocument();
  });

  it('restores the full list from the inline × clear control', () => {
    renderBand({ tasks: [makeTask({ id: 'a', name: 'Login rework' }), ...padIdeas(7)] });
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /Filter backlog ideas/i,
    });
    fireEvent.change(input, { target: { value: 'login' } });
    expect(screen.queryByText('Padding idea 0')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear backlog search' }));
    expect(input.value).toBe('');
    expect(screen.getByText('Padding idea 0')).toBeInTheDocument();
    expect(screen.getByText('Login rework')).toBeInTheDocument();
  });

  it('hides the × clear control until a query is typed', () => {
    renderBand({ tasks: padIdeas(8) });
    expect(screen.queryByRole('button', { name: 'Clear backlog search' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /Filter backlog ideas/i }), {
      target: { value: 'padding' },
    });
    expect(screen.getByRole('button', { name: 'Clear backlog search' })).toBeInTheDocument();
  });

  it('omits the ⌘K handoff when no palette handler is wired', () => {
    renderBand({ tasks: padIdeas(8) });
    expect(screen.queryByRole('button', { name: /command palette/i })).not.toBeInTheDocument();
  });
});

describe('BacklogBand — late quick-capture failure (#2030)', () => {
  it('leaves an already-refilled capture field untouched when the error arrives late', () => {
    let onError: (() => void) | undefined;
    const onQuickCapture = vi.fn<(name: string, opts?: { onError?: () => void }) => void>(
      (_name, opts) => {
        onError = opts?.onError;
      },
    );
    renderBand({ tasks: [], onQuickCapture });
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /Capture a backlog idea/i,
    });
    fireEvent.change(input, { target: { value: 'First idea' } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');

    // The user has already started the next idea before the failure comes back.
    fireEvent.change(input, { target: { value: 'Second idea' } });
    act(() => {
      onError?.();
    });
    expect(input.value).toBe('Second idea');
  });
});

describe('BacklogBand — collapsed strip', () => {
  it('pluralizes the rotated count for multiple ideas', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    renderBand({ tasks: [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })] });
    expect(screen.getByRole('button', { name: 'Expand backlog rail, 3 ideas' })).toBeInTheDocument();
    expect(screen.getByText(/Backlog · 3/)).toBeInTheDocument();
  });

  it('uses the singular in the rotated count for one idea', () => {
    localStorage.setItem('trueppm.board.backlogBand.collapsed', '1');
    renderBand({ tasks: [makeTask()] });
    expect(screen.getByRole('button', { name: 'Expand backlog rail, 1 idea' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// "File under…" (#2952) — the keyboard and touch path for what the rail
// previously only offered as a drag.
// ---------------------------------------------------------------------------
describe('BacklogCard "File under…"', () => {
  const TARGETS = [
    { id: 'root', name: 'Test Project' },
    { id: 'phase-1', name: 'Discovery' },
    { id: 'phase-2', name: 'Build' },
  ];

  function openMenu(cardName: string) {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${cardName}` }));
  }

  it('files the card under the chosen container', () => {
    const onFileUnder = vi.fn();
    renderBand({
      tasks: [makeTask({ id: 'idea-1', name: 'Spike auth flow' })],
      fileUnderTargets: TARGETS,
      onFileUnder,
    });

    openMenu('Spike auth flow');
    fireEvent.click(screen.getByRole('menuitem', { name: 'File under…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build' }));

    expect(onFileUnder).toHaveBeenCalledTimes(1);
    expect(onFileUnder.mock.calls[0][0]).toMatchObject({ id: 'idea-1' });
    expect(onFileUnder.mock.calls[0][1]).toBe('phase-2');
  });

  it('lists every container the board is grouped by, including the project root', () => {
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      fileUnderTargets: TARGETS,
      onFileUnder: vi.fn(),
    });
    openMenu('Spike auth flow');
    fireEvent.click(screen.getByRole('menuitem', { name: 'File under…' }));
    for (const t of TARGETS) {
      expect(screen.getByRole('menuitem', { name: t.name })).toBeInTheDocument();
    }
  });

  it('a read-only rail offers no ··· at all — absence, not disabled (rule 302)', () => {
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      fileUnderTargets: TARGETS,
      // Both callers pass `undefined` read-only; the rail also drops them
      // itself, so neither layer alone can leak a write action to a Viewer.
      onFileUnder: vi.fn(),
      onSchedule: vi.fn(),
      readOnly: true,
    });
    expect(screen.queryByRole('button', { name: 'Actions for Spike auth flow' })).toBeNull();
  });

  it('a read-only rail describes no promotion path either', () => {
    renderBand({ tasks: [makeTask()], fileUnderTargets: TARGETS, readOnly: true });
    // A sentence naming two gestures a Viewer cannot perform is the same false
    // capability claim as a dead button, in copy.
    expect(screen.queryByText(/File under…/)).toBeNull();
    expect(screen.queryByText(/Drag right onto a phase/)).toBeNull();
  });

  it('falls back to the drag-only hint when there is nothing to file into', () => {
    renderBand({ tasks: [makeTask()], fileUnderTargets: [], onFileUnder: vi.fn() });
    expect(screen.getByText(/Drag right onto a phase/)).toBeInTheDocument();
    expect(screen.queryByText(/File under…/)).toBeNull();
  });

  it('returns focus to the capture field after filing, since the card unmounts', () => {
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      fileUnderTargets: TARGETS,
      onFileUnder: vi.fn(),
      onQuickCapture: vi.fn(),
    });
    openMenu('Spike auth flow');
    fireEvent.click(screen.getByRole('menuitem', { name: 'File under…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build' }));
    expect(screen.getByRole('textbox', { name: /Capture a backlog idea/i })).toHaveFocus();
  });

  it('offers no File under… when the board has no containers to file into', () => {
    // Assignee (324) / epic (364) grouping: a lane id is a resource or an epic,
    // not a WBS parent, so BoardView passes an empty target list.
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      fileUnderTargets: [],
      onFileUnder: vi.fn(),
      onSchedule: vi.fn(),
    });
    openMenu('Spike auth flow');
    expect(screen.queryByRole('menuitem', { name: 'File under…' })).toBeNull();
  });

  it('renders no ··· at all when there is nothing to offer', () => {
    renderBand({ tasks: [makeTask({ name: 'Spike auth flow' })], fileUnderTargets: [] });
    expect(screen.queryByRole('button', { name: 'Actions for Spike auth flow' })).toBeNull();
  });

  it('walks the menu with the arrow keys and closes on Escape', () => {
    renderBand({
      tasks: [makeTask({ name: 'Spike auth flow' })],
      fileUnderTargets: TARGETS,
      onFileUnder: vi.fn(),
      onSchedule: vi.fn(),
    });
    const trigger = screen.getByRole('button', { name: 'Actions for Spike auth flow' });
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Actions for Spike auth flow' });
    expect(screen.getByRole('menuitem', { name: 'File under…' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Schedule…' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
