import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { BoardCardPopover } from './index';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';

const sprintsState = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [], isLoading: false, error: sprintsState.error }),
}));

function renderIt() {
  const task = { id: 't1', title: 'T', sprintId: 'sp1', assignees: [] } as unknown as Task;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BoardCardPopover
          task={task}
          projectId="p1"
          anchor={{ top: 0, left: 0, width: 10, height: 10 } as never}
          isMobile={false}
          onOpenDetail={vi.fn()}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BoardCardPopover sprint chip on a failed read (#3517)', () => {
  it('shows "unavailable", not a permanent "…", when the sprints read failed', () => {
    sprintsState.error = new Error('boom');
    renderIt();
    expect(screen.getByTitle('Sprint: unavailable')).toBeInTheDocument();
  });

  it('keeps the in-flight "…" placeholder when there is no error', () => {
    sprintsState.error = null;
    renderIt();
    expect(screen.getByTitle('Sprint: …')).toBeInTheDocument();
  });
});
