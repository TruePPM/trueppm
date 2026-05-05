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
});
