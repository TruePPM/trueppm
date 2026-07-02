import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import type { MyWorkTask } from '@/hooks/useMyWork';

// Spy on the warm toast + stub the optimistic status mutation so the complete
// flow is deterministic (no network): mutate() invokes its onSuccess synchronously.
const { warmSpy, mutateSpy } = vi.hoisted(() => ({
  warmSpy: vi.fn(),
  mutateSpy: vi.fn((_args: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
}));
vi.mock('@/components/Toast', () => ({
  toast: { warm: warmSpy, info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/useMyWork', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useMyWork')>()),
  useMyWorkStatusUpdate: () => ({ mutate: mutateSpy, isPending: false }),
}));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ul>{ui}</ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BASE: MyWorkTask = {
  id: 't1',
  short_id: 'PRJ-01',
  name: 'Build login',
  project_id: 'p1',
  project_name: 'App',
  program_id: 'prog1',
  program_name: 'Apollo Program',
  program_color: '#3366cc',
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: null,
  remaining_points: null,
  due: null,
  due_source: 'planned',
  is_critical: false,
  group: 'today',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 1,
  url: '/projects/p1/schedule?task=t1',
};

describe('MyWorkTaskRow blocker badge (ADR-0124 #1135)', () => {
  it('renders no blocker badge when not blocked', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('renders the type chip and age badge when blocked with a type', () => {
    wrap(
      <MyWorkTaskRow
        task={{
          ...BASE,
          is_blocked: true,
          blocked_reason: 'waiting on legal',
          blocker_type: 'vendor',
          blocked_age_seconds: 93600, // 1d 2h
        }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('External vendor')).toBeInTheDocument();
    expect(screen.getByText('1d 2h blocked')).toBeInTheDocument();
    // My Work is the assignee's own surface, so the reason renders here.
    expect(screen.getByText('waiting on legal')).toBeInTheDocument();
  });

  it('omits the type chip when blocked with no structured type (paused)', () => {
    wrap(
      <MyWorkTaskRow
        task={{
          ...BASE,
          is_blocked: true,
          blocked_reason: 'just stuck',
          blocker_type: '',
          blocked_age_seconds: 3600,
        }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByText('External vendor')).not.toBeInTheDocument();
    expect(screen.getByText('1h blocked')).toBeInTheDocument();
  });
});

describe('MyWorkTaskRow complete checkbox (#1226)', () => {
  beforeEach(() => {
    warmSpy.mockClear();
    mutateSpy.mockClear();
  });

  it('renders a "Mark complete" checkbox for an incomplete task', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    expect(screen.getByRole('button', { name: 'Mark Build login complete' })).toBeInTheDocument();
  });

  it('completing requests COMPLETE, plays the checkpop spring, and fires the warm toast (rule 184)', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    const checkbox = screen.getByRole('button', { name: 'Mark Build login complete' });
    fireEvent.click(checkbox);
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', next: 'COMPLETE' }),
      expect.anything(),
    );
    expect(warmSpy).toHaveBeenCalledWith('Nice — Build login done.');
    // the check box plays the one-shot spring (cleared on animationend)
    expect(checkbox.querySelector('span')?.className).toContain('motion-safe:animate-checkpop');
  });

  it('shows a checked, non-interactive checkbox for an already-complete task', () => {
    wrap(<MyWorkTaskRow task={{ ...BASE, status: 'COMPLETE' }} />);
    const checkbox = screen.getByRole('button', { name: 'Build login is complete' });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-pressed', 'true');
    expect(warmSpy).not.toHaveBeenCalled();
  });
});

describe('MyWorkTaskRow program identity (#964)', () => {
  it('renders the program name as the accessible signal', () => {
    wrap(<MyWorkTaskRow task={BASE} />);
    // The program NAME is the a11y signal — the square itself is aria-hidden.
    expect(screen.getByText('Apollo Program')).toBeInTheDocument();
  });

  it('renders a decorative (aria-hidden) identity square carrying the accent color', () => {
    const { container } = wrap(<MyWorkTaskRow task={BASE} />);
    const square = container.querySelector('span[aria-hidden="true"][style]');
    expect(square).not.toBeNull();
    // Dynamic accent flows through the style prop (never a hex class).
    expect(square).toHaveStyle({ backgroundColor: '#3366cc' });
  });

  it('renders the neutral unset square and no name for an orphan project (no program)', () => {
    wrap(
      <MyWorkTaskRow
        task={{ ...BASE, program_id: null, program_name: null, program_color: null }}
      />,
    );
    // No program name text when the project has no program.
    expect(screen.queryByText('Apollo Program')).not.toBeInTheDocument();
    // The neutral square still renders (faint filled square, no inline color).
    const square = document.querySelector('span[aria-hidden="true"].bg-neutral-surface-sunken');
    expect(square).not.toBeNull();
  });
});
