import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type {
  SaveRetroPayload,
  SprintRetroPayload,
  SprintRetroSummaryPayload,
  RetroVisibility,
} from '@/hooks/useSprints';
import { RetroPanel } from './RetroPanel';

interface SprintRetroQueryResult {
  data: SprintRetroPayload | SprintRetroSummaryPayload | null;
  isLoading: boolean;
  error: unknown;
}

interface MutationResult<TArgs> {
  mutate: (args: TArgs) => void;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
}

const useSprintRetroMock = vi.fn<() => SprintRetroQueryResult>();
const useSprintRetroPriorMock = vi.fn<() => SprintRetroQueryResult>(() => ({
  data: null,
  isLoading: false,
  error: null,
}));
const saveMutateMock = vi.fn<(payload: SaveRetroPayload) => void>();
const useSaveSprintRetroMock = vi.fn<() => MutationResult<SaveRetroPayload>>(() => ({
  mutate: saveMutateMock,
  isPending: false,
  isError: false,
  isSuccess: false,
}));
const promoteMutateMock = vi.fn<(itemId: string) => void>();
const usePromoteRetroActionItemMock = vi.fn<() => MutationResult<string>>(() => ({
  mutate: promoteMutateMock,
  isPending: false,
  isError: false,
  isSuccess: false,
}));
const visibilityMutateMock = vi.fn<(v: RetroVisibility) => void>();
const useUpdateRetroVisibilityMock = vi.fn<() => MutationResult<RetroVisibility>>(() => ({
  mutate: visibilityMutateMock,
  isPending: false,
  isError: false,
  isSuccess: false,
}));

vi.mock('@/hooks/useSprints', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSprints')>(
    '@/hooks/useSprints',
  );
  return {
    ...actual,
    useSprintRetro: () => useSprintRetroMock(),
    useSprintRetroPrior: () => useSprintRetroPriorMock(),
    useSaveSprintRetro: () => useSaveSprintRetroMock(),
    usePromoteRetroActionItem: () => usePromoteRetroActionItemMock(),
    useUpdateRetroVisibility: () => useUpdateRetroVisibilityMock(),
  };
});

function fullRetro(overrides: Partial<SprintRetroPayload> = {}): SprintRetroPayload {
  return {
    kind: 'full',
    id: 'r1',
    sprint: 'sp-1',
    notes: '',
    team_visibility: 'team_only',
    created_by: null,
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
    action_items: [],
    ...overrides,
  };
}

beforeEach(() => {
  saveMutateMock.mockReset();
  promoteMutateMock.mockReset();
  visibilityMutateMock.mockReset();
  useSaveSprintRetroMock.mockReturnValue({
    mutate: saveMutateMock,
    isPending: false,
    isError: false,
    isSuccess: false,
  });
  usePromoteRetroActionItemMock.mockReturnValue({
    mutate: promoteMutateMock,
    isPending: false,
    isError: false,
    isSuccess: false,
  });
  useUpdateRetroVisibilityMock.mockReturnValue({
    mutate: visibilityMutateMock,
    isPending: false,
    isError: false,
    isSuccess: false,
  });
  useSprintRetroPriorMock.mockReturnValue({ data: null, isLoading: false, error: null });
});

describe('RetroPanel', () => {
  it('renders the section heading and helper copy when a retro is missing', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
    expect(
      screen.getByRole('heading', { level: 2, name: /Retrospective/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/promote each explicitly/i)).toBeInTheDocument();
    expect(screen.getByText(/No action items yet/i)).toBeInTheDocument();
  });

  it('hydrates the form from the existing retro and shows the promoted task chip', async () => {
    useSprintRetroMock.mockReturnValue({
      data: fullRetro({
        notes: 'Burndown skewed',
        action_items: [
          {
            id: 'ai1',
            text: 'Add deploy gate',
            assignee: null,
            assignee_username: null,
            story_points: 3,
            promoted_task_id: 'task-uuid-aaaaaa',
            created_at: '2026-04-15T00:00:00Z',
          },
        ],
      }),
      isLoading: false,
      error: null,
    });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} />);

    expect(await screen.findByDisplayValue('Burndown skewed')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Add deploy gate')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    expect(screen.getByText(/T-task-u/i)).toBeInTheDocument();
  });

  it('renders the Promote button on an unpromoted persisted item and fires the mutation', async () => {
    useSprintRetroMock.mockReturnValue({
      data: fullRetro({
        action_items: [
          {
            id: 'ai1',
            text: 'Pair more on billing',
            assignee: null,
            assignee_username: null,
            story_points: null,
            promoted_task_id: null,
            created_at: '2026-04-15T00:00:00Z',
          },
        ],
      }),
      isLoading: false,
      error: null,
    });

    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} />);
    const promoteBtn = await screen.findByRole('button', {
      name: /Promote action item 1 to backlog/i,
    });
    await userEvent.click(promoteBtn);
    expect(promoteMutateMock).toHaveBeenCalledWith('ai1');
  });

  it('renders summary card when the response is a summary payload', () => {
    const summary: SprintRetroSummaryPayload = {
      kind: 'summary',
      id: 'r1',
      sprint: 'sp-1',
      team_visibility: 'team_only',
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
      action_items_count: 4,
      promoted_count: 2,
    };
    useSprintRetroMock.mockReturnValue({
      data: summary,
      isLoading: false,
      error: null,
    });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} />);
    expect(screen.getByText(/private to the sprint team/i)).toBeInTheDocument();
    expect(screen.getByText(/4 action items/i)).toBeInTheDocument();
  });

  it('renders the visibility toggle when canEditVisibility is true', () => {
    useSprintRetroMock.mockReturnValue({
      data: fullRetro(),
      isLoading: false,
      error: null,
    });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} canEditVisibility />);
    expect(screen.getByRole('radiogroup', { name: /Retrospective visibility/i })).toBeInTheDocument();
  });

  it('fires the visibility mutation when a different option is clicked', async () => {
    useSprintRetroMock.mockReturnValue({
      data: fullRetro(),
      isLoading: false,
      error: null,
    });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} canEditVisibility />);
    await userEvent.click(screen.getByRole('radio', { name: /Project/i }));
    expect(visibilityMutateMock).toHaveBeenCalledWith('project');
  });

  it('shows the closed-sprint helper copy when isClosed', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={true} />);
    expect(screen.getByText(/can be amended after close/i)).toBeInTheDocument();
  });

  it('saves with trimmed text and no auto-promote flag', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Notes/i }),
      '  team unblocked  ',
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.type(screen.getByLabelText(/Action item 1 text/i), '  Add deploy gate  ');
    await userEvent.type(screen.getByLabelText(/Action item 1 story points/i), '3');
    await userEvent.click(screen.getByRole('button', { name: /Save retro/i }));

    expect(saveMutateMock).toHaveBeenCalledOnce();
    const payload = saveMutateMock.mock.calls[0][0];
    expect(payload.notes).toBe('team unblocked');
    expect(payload.action_items).toEqual([{ text: 'Add deploy gate', story_points: 3 }]);
  });
});
