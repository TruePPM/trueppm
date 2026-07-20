import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Task } from '@/types';
import { SprintCommitButton } from './SprintCommitButton';

const mutateMock = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: mutateMock, isPending: false }),
}));

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: toastErrorMock } }));

function makeStory(over: Partial<Task>): Task {
  return {
    id: 'story-1',
    name: 'Pay with card',
    sprintId: null,
    sprintPending: false,
    assignees: [],
    ...over,
  } as unknown as Task;
}

const PLANNED = { id: 'sp-1', short_id_display: 'SP-A1' };

function renderBtn(props: Partial<ComponentProps<typeof SprintCommitButton>> = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SprintCommitButton
        story={makeStory({})}
        projectId="p1"
        plannedSprint={PLANNED}
        canManage
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mutateMock.mockReset();
  toastErrorMock.mockReset();
});

describe('SprintCommitButton', () => {
  it('shows "+ Add" for an uncommitted story and commits it into the planned sprint on click', () => {
    renderBtn({ story: makeStory({ sprintId: null }) });
    fireEvent.click(screen.getByRole('button', { name: /Add Pay with card to SP-A1/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      { id: 'story-1', projectId: 'p1', sprint: 'sp-1' },
      expect.anything(),
    );
  });

  it('shows the committed state for a story in the planned sprint and removes it on click', () => {
    renderBtn({ story: makeStory({ sprintId: 'sp-1' }) });
    fireEvent.click(screen.getByRole('button', { name: /Remove Pay with card from SP-A1/i }));
    expect(mutateMock).toHaveBeenCalledWith(
      { id: 'story-1', projectId: 'p1', sprint: null },
      expect.anything(),
    );
  });

  it('falls back to the read-only chip when there is no planned sprint', () => {
    renderBtn({ plannedSprint: null });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to read-only when the reader cannot manage the backlog', () => {
    renderBtn({ canManage: false });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays read-only for a story committed to a different sprint', () => {
    renderBtn({ story: makeStory({ sprintId: 'other-sprint' }) });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('toasts a generic error when a non-conflict write fails (#2150)', () => {
    renderBtn({ story: makeStory({ sprintId: null }) });
    fireEvent.click(screen.getByRole('button', { name: /Add Pay with card to SP-A1/i }));
    // useUpdateTask already handles the 409 toast; the call-site fallback covers
    // the 403/500/network case that otherwise rolled back silently.
    const opts = mutateMock.mock.calls[0][1] as { onError: (e: unknown) => void };
    opts.onError(new Error('network'));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't add the story — try again.");
  });

  it('does NOT double-toast when the write fails with a sync conflict (409)', () => {
    renderBtn({ story: makeStory({ sprintId: null }) });
    fireEvent.click(screen.getByRole('button', { name: /Add Pay with card to SP-A1/i }));
    const opts = mutateMock.mock.calls[0][1] as { onError: (e: unknown) => void };
    // Shape of a sync-conflict axios error (useUpdateTask owns that toast).
    opts.onError({
      isAxiosError: true,
      response: { status: 409, data: { code: 'sync_conflict' } },
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
