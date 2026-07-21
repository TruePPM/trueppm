import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';

import type { BlockedRollup, BlockedRow } from '@/hooks/useBlockedRollup';
import { BlockedRollupPanel } from './BlockedRollupPanel';

// The panel now renders <Link>s (issue #2159), so every render needs a Router.
function renderInRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// Keep the real isImpediment (pure); stub only the data hooks.
let projectResult: { data?: BlockedRollup; isLoading: boolean } = { isLoading: false };
let sprintResult: { data?: BlockedRollup; isLoading: boolean } = { isLoading: false };
vi.mock('@/hooks/useBlockedRollup', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/useBlockedRollup')>();
  return {
    ...actual,
    useProjectBlocked: () => projectResult,
    useSprintBlocked: () => sprintResult,
  };
});

const ROWS: BlockedRow[] = [
  {
    task_id: 't1',
    task_short_id: 'T-1',
    title: 'Pour foundation',
    assignee: { id: 'u1', username: 'priya' },
    blocker_type: 'vendor',
    blocked_since: '2026-06-08T00:00:00Z',
    blocked_age_seconds: 6 * 86400, // 6 days → critical band
    blocked_by: { id: 'u2', username: 'alex' },
    blocking_task: { id: 't9', short_id: 'T-9', title: 'Permit approval' },
  },
  {
    task_id: 't2',
    task_short_id: 'T-2',
    title: 'Staging deploy',
    assignee: null,
    blocker_type: null, // no type → "paused"
    blocked_since: '2026-06-14T00:00:00Z',
    blocked_age_seconds: 3600,
    blocked_by: null,
    blocking_task: null,
  },
];

afterEach(() => {
  projectResult = { isLoading: false };
  sprintResult = { isLoading: false };
});

describe('BlockedRollupPanel — project scope', () => {
  it('renders rows with type chip, age, assignee, and the soft link — never a reason', () => {
    projectResult = { data: { count: 2, blocked: ROWS }, isLoading: false };
    renderInRouter(<BlockedRollupPanel scope="project" projectId="p1" />);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Pour foundation')).toBeInTheDocument();
    expect(screen.getByText('External vendor')).toBeInTheDocument();
    expect(screen.getByText('6d blocked')).toBeInTheDocument();
    expect(screen.getByText('priya')).toBeInTheDocument();
    // Soft "waiting on" wrapper (issue 1156) — framed as informational, not a CPM edge.
    const softWrapper = screen.getByText(/waiting on/i);
    expect(softWrapper).toHaveAttribute('title', expect.stringMatching(/does not affect the schedule/i));
  });

  it('links the row title and the waiting-on reference into the task drawer (#2159)', () => {
    projectResult = { data: { count: 1, blocked: [ROWS[0]] }, isLoading: false };
    renderInRouter(<BlockedRollupPanel scope="project" projectId="p1" />);
    // Title opens the blocked task (the short-id is part of the title link's
    // accessible name); the waiting-on link opens the blocking task.
    expect(screen.getByRole('link', { name: /Pour foundation/ })).toHaveAttribute(
      'href',
      '/projects/p1/tasks/t1',
    );
    expect(screen.getByRole('link', { name: 'Waiting on T-9. View task.' })).toHaveAttribute(
      'href',
      '/projects/p1/tasks/t9',
    );
  });

  it('escalation-colors an old blocker red', () => {
    projectResult = { data: { count: 1, blocked: [ROWS[0]] }, isLoading: false };
    renderInRouter(<BlockedRollupPanel scope="project" projectId="p1" />);
    expect(screen.getByText('6d blocked').className).toContain('text-semantic-critical');
  });

  it('shows a warm empty state when nothing is blocked', () => {
    projectResult = { data: { count: 0, blocked: [] }, isLoading: false };
    renderInRouter(<BlockedRollupPanel scope="project" projectId="p1" />);
    expect(screen.getByText(/No blocked tasks/)).toBeInTheDocument();
  });
});

describe('BlockedRollupPanel — sprint scope', () => {
  it('shows the impediment vs paused split and filters on the toggle', () => {
    sprintResult = { data: { count: 2, blocked: ROWS }, isLoading: false };
    renderInRouter(<BlockedRollupPanel scope="sprint" sprintId="s1" projectId="p1" />);
    const section = screen.getByRole('region', { name: 'Impediments & paused' });
    expect(within(section).getByText(/1 impediment · 1 paused/)).toBeInTheDocument();

    // Default All — both rows.
    expect(within(section).getByText('Pour foundation')).toBeInTheDocument();
    expect(within(section).getByText('Staging deploy')).toBeInTheDocument();

    // Paused → only the untyped row.
    fireEvent.click(within(section).getByRole('button', { name: 'Paused' }));
    expect(within(section).queryByText('Pour foundation')).not.toBeInTheDocument();
    expect(within(section).getByText('Staging deploy')).toBeInTheDocument();

    // Impediments → only the typed row.
    fireEvent.click(within(section).getByRole('button', { name: 'Impediments' }));
    expect(within(section).getByText('Pour foundation')).toBeInTheDocument();
    expect(within(section).queryByText('Staging deploy')).not.toBeInTheDocument();
  });
});
