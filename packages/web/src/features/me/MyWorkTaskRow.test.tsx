import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { MyWorkTaskRow } from './MyWorkTaskRow';
import type { MyWorkTask } from '@/hooks/useMyWork';

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
