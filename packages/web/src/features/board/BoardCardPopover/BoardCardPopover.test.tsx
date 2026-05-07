import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { BoardCardPopover } from './index';

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: { count: 0, next: null, previous: null, results: [] } }),
  },
}));

const PROJECT_ID = 'project-1';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1.1',
    name: 'Design review with stakeholders',
    start: '2026-05-04',
    finish: '2026-05-08',
    plannedStart: '2026-05-04',
    duration: 5,
    progress: 40,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    readiness: 'ready',
    notes: '',
    ...over,
  };
}

function renderPopover(task: Task, override: Partial<Parameters<typeof BoardCardPopover>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: Parameters<typeof BoardCardPopover>[0] = {
    task,
    projectId: PROJECT_ID,
    anchor: document.createElement('div'),
    isMobile: false,
    onOpenDetail: vi.fn(),
    onEdit: vi.fn(),
    onClose: vi.fn(),
    ...override,
  };
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BoardCardPopover {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, props };
}

describe('BoardCardPopover (issue #304)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task name, WBS, status pill, and a duration suffix on the dates row', () => {
    renderPopover(baseTask());
    expect(screen.getByRole('heading', { name: /Design review with stakeholders/ })).toBeInTheDocument();
    expect(screen.getByText('WBS 1.1')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: In progress')).toBeInTheDocument();
    // Date strings are TZ-sensitive (formatShortDate parses ISO as UTC and
    // formats in local TZ); the duration suffix is the deterministic anchor.
    expect(screen.getByText(/5d/)).toBeInTheDocument();
  });

  it('renders the CP pill and float chip on a scheduled critical task', () => {
    renderPopover(baseTask({ isCritical: true, totalFloat: 0 }));
    expect(screen.getByLabelText('On critical path')).toBeInTheDocument();
    expect(screen.getByText(/0d float — on critical path/)).toBeInTheDocument();
  });

  it('suppresses the CP pill and float row on an uncommitted backlog task (#332 alignment)', () => {
    renderPopover(
      baseTask({
        status: 'BACKLOG',
        plannedStart: null,
        isCritical: true,
        totalFloat: 0,
      }),
    );
    // CP pill is suppressed because the gate keys on plannedStart, not isCritical alone.
    expect(screen.queryByLabelText('On critical path')).not.toBeInTheDocument();
    // Dates row shows the "Not scheduled" placeholder.
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    // Float row is hidden entirely.
    expect(screen.queryByText(/float/i)).not.toBeInTheDocument();
  });

  it('renders Unassigned when the task has no assignees', () => {
    renderPopover(baseTask({ assignees: [] }));
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('renders assignee initials when present', () => {
    renderPopover(
      baseTask({
        assignees: [
          { resourceId: 'r1', name: 'Maya Patel', units: 0.6 },
          { resourceId: 'r2', name: 'Jordan Cho', units: 0.4 },
        ],
      }),
    );
    expect(screen.getByLabelText('Maya Patel')).toBeInTheDocument();
    expect(screen.getByLabelText('Jordan Cho')).toBeInTheDocument();
  });

  it('renders a placeholder Sprint chip when sprintId is set but the sprint name has not loaded', () => {
    renderPopover(baseTask({ sprintId: 'sprint-uuid-1' }));
    // Initial render before the useSprints query resolves — chip falls back to "…" text.
    expect(screen.getByTitle(/^Sprint:/)).toBeInTheDocument();
  });

  it('does not render a Sprint chip when sprintId is null', () => {
    renderPopover(baseTask({ sprintId: null }));
    expect(screen.queryByTitle(/^Sprint:/)).not.toBeInTheDocument();
  });

  it('fires onOpenDetail when the primary footer button is clicked', () => {
    const { props } = renderPopover(baseTask());
    fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
    expect(props.onOpenDetail).toHaveBeenCalledTimes(1);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('fires onEdit when the Edit footer button is clicked', () => {
    const { props } = renderPopover(baseTask());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onOpenDetail).not.toHaveBeenCalled();
  });

  it('fires onClose when Escape is pressed', () => {
    const { props } = renderPopover(baseTask());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes role=dialog with aria-labelledby pointing to the title', () => {
    renderPopover(baseTask());
    const dialog = screen.getByRole('dialog');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBe('card-popover-title-t1');
    const title = document.getElementById(titleId!);
    expect(title?.textContent).toMatch(/Design review/);
  });

  it('renders the mobile bottom-sheet shell when isMobile=true', () => {
    renderPopover(baseTask(), { isMobile: true });
    const dialog = screen.getByRole('dialog');
    // Mobile uses aria-modal=true (focus trap, scrim); desktop uses aria-modal=false.
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('exposes aria-modal=false on the desktop popover', () => {
    renderPopover(baseTask(), { isMobile: false });
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('false');
  });

  it('closes on pointerdown outside both the popover and the anchor', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const { props } = renderPopover(baseTask(), { anchor });
    fireEvent.pointerDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    document.body.removeChild(anchor);
  });

  it('does not close on pointerdown inside the anchor (re-open guard)', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const { props } = renderPopover(baseTask(), { anchor });
    fireEvent.pointerDown(anchor);
    expect(props.onClose).not.toHaveBeenCalled();
    document.body.removeChild(anchor);
  });

  it('does not close on pointerdown inside the popover content', () => {
    const { props } = renderPopover(baseTask());
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('closes on scrim tap on mobile', () => {
    const { container, props } = renderPopover(baseTask(), { isMobile: true });
    // Scrim is the first child div with aria-hidden="true" and bg-black/40 sibling-of-dialog.
    const scrim = container.querySelector('[aria-hidden="true"].bg-black\\/40') as HTMLElement;
    expect(scrim).toBeTruthy();
    fireEvent.pointerDown(scrim);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a neutral float chip for a scheduled non-critical task with totalFloat set', () => {
    renderPopover(baseTask({ isCritical: false, totalFloat: 3 }));
    expect(screen.getByText(/^3d float$/)).toBeInTheDocument();
    expect(screen.queryByText(/critical path/)).not.toBeInTheDocument();
  });

  it.each([
    ['COMPLETE', 'Complete'],
    ['REVIEW', 'Review'],
    ['BACKLOG', 'Backlog'],
    ['ON_HOLD', 'On hold'],
    ['NOT_STARTED', 'To Do'],
  ] as const)('renders the %s status pill with the correct label', (status, label) => {
    renderPopover(baseTask({ status }));
    expect(screen.getByLabelText(`Status: ${label}`)).toBeInTheDocument();
  });

  it.each(['idea', 'estimated', 'baselined'] as const)(
    'renders the %s readiness chip variant',
    (readiness) => {
      renderPopover(baseTask({ readiness }));
      expect(screen.getByText(readiness)).toBeInTheDocument();
    },
  );

  it('renders a single-letter initial for a one-word assignee name', () => {
    renderPopover(
      baseTask({
        assignees: [{ resourceId: 'r1', name: 'Maya', units: 1 }],
      }),
    );
    const chip = screen.getByLabelText('Maya');
    expect(chip.textContent).toBe('M');
  });

  it('falls back to "?" initials when an assignee name is whitespace', () => {
    const { container } = renderPopover(
      baseTask({
        assignees: [{ resourceId: 'r1', name: '   ', units: 1 }],
      }),
    );
    // Whitespace `aria-label` is normalised by accessible-name lookups;
    // assert directly on the assignee chip's text content instead.
    const chip = container.querySelector('.bg-brand-primary.font-bold');
    expect(chip?.textContent).toBe('?');
  });

  it('traps Tab focus inside the dialog on mobile (Tab from last → first)', () => {
    renderPopover(baseTask(), { isMobile: true });
    const dialog = screen.getByRole('dialog');
    const focusables = dialog.querySelectorAll<HTMLElement>('button');
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    const first = focusables[0];
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('traps Shift+Tab focus inside the dialog on mobile (Shift+Tab from first → last)', () => {
    renderPopover(baseTask(), { isMobile: true });
    const dialog = screen.getByRole('dialog');
    const focusables = dialog.querySelectorAll<HTMLElement>('button');
    const first = focusables[0];
    first.focus();
    expect(document.activeElement).toBe(first);
    const last = focusables[focusables.length - 1];
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
