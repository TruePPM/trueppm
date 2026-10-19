import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, renderWithRouter } from '@/test/utils';
import type {
  SaveRetroPayload,
  SprintRetroActionItem,
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
const saveMutateMock =
  vi.fn<
    (payload: SaveRetroPayload, opts?: { onSuccess?: (data: SprintRetroPayload) => void }) => void
  >();
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

// The live board + pulse hooks are exercised in TeamHealthPulse.test.tsx /
// RetroBoardSurface.test.tsx. Here we stub them so the single-author
// notes/actions path (this file's focus, #858) renders without real fetches:
// an empty board and a gated pulse keep the surface to its action-item section.
const idleMutation = { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false };
vi.mock('@/hooks/useRetroBoard', () => ({
  useRetroBoard: () => ({ data: undefined, isLoading: false }),
  useCreateBoardItem: () => idleMutation,
  useUpdateBoardItem: () => idleMutation,
  useDeleteBoardItem: () => idleMutation,
  useConvertStickyToAction: () => idleMutation,
  usePulse: () => ({ data: null, isLoading: false }),
  usePulseTrend: () => ({ data: { gated: true }, isLoading: false }),
  useUpsertPulse: () => idleMutation,
}));

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
    // Uses renderWithRouter: the promoted-task chip is now a react-router
    // <Link> (was a dead #task- anchor), which requires a Router context.
    renderWithRouter(<RetroPanel sprintId="sp-1" isClosed={true} />);

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
    await userEvent.click(screen.getByRole('button', { name: /Save notes & actions/i }));

    expect(saveMutateMock).toHaveBeenCalledOnce();
    const payload = saveMutateMock.mock.calls[0][0];
    expect(payload.notes).toBe('team unblocked');
    expect(payload.action_items).toEqual([{ text: 'Add deploy gate', story_points: 3 }]);
  });

  it('sends each persisted item id back so the save edits it instead of replacing it (#4591)', async () => {
    useSprintRetroMock.mockReturnValue({
      data: fullRetro({
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
    renderWithRouter(<RetroPanel sprintId="sp-1" isClosed={true} />);
    await screen.findByDisplayValue('Add deploy gate');
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.type(screen.getByLabelText(/Action item 2 text/i), 'New thing');
    await userEvent.click(screen.getByRole('button', { name: /Save notes & actions/i }));

    const payload = saveMutateMock.mock.calls[0][0];
    expect(payload.action_items).toEqual([
      { id: 'ai1', text: 'Add deploy gate', story_points: 3 },
      { text: 'New thing', story_points: null },
    ]);
  });

  it('adopts the server ids after a save so the next save does not recreate the items', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    saveMutateMock.mockImplementation((_payload, opts) => {
      opts?.onSuccess?.(
        fullRetro({
          action_items: [
            {
              id: 'ai-new',
              text: 'Add deploy gate',
              assignee: null,
              assignee_username: null,
              story_points: null,
              promoted_task_id: null,
              created_at: '2026-04-15T00:00:00Z',
            },
          ],
        }),
      );
    });
    renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.type(screen.getByLabelText(/Action item 1 text/i), 'Add deploy gate');
    const saveBtn = screen.getByRole('button', { name: /Save notes & actions/i });
    await userEvent.click(saveBtn);
    await userEvent.click(saveBtn);

    expect(saveMutateMock).toHaveBeenCalledTimes(2);
    expect(saveMutateMock.mock.calls[0][0].action_items).toEqual([
      { text: 'Add deploy gate', story_points: null },
    ]);
    expect(saveMutateMock.mock.calls[1][0].action_items).toEqual([
      { id: 'ai-new', text: 'Add deploy gate', story_points: null },
    ]);
  });

  describe('draft reconciliation with the server (#4591)', () => {
    function item(id: string, text: string): SprintRetroActionItem {
      return {
        id,
        text,
        assignee: null,
        assignee_username: null,
        story_points: null,
        promoted_task_id: null,
        created_at: '2026-04-15T00:00:00Z',
      };
    }
    type SaveOpts = { onSuccess?: (data: SprintRetroPayload) => void };
    const saveBtn = () => screen.getByRole('button', { name: /Save notes & actions/i });

    it('keeps edits typed while the save is in flight and still adopts the new ids', async () => {
      useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
      let pending: SaveOpts | undefined;
      saveMutateMock.mockImplementationOnce((_p, opts) => {
        pending = opts;
      });
      renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
      await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
      await userEvent.type(screen.getByLabelText(/Action item 1 text/i), 'Gate');
      await userEvent.click(saveBtn());

      // While the POST is in flight: extend item 1 and add item 2.
      await userEvent.type(screen.getByLabelText(/Action item 1 text/i), ' deploys');
      await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
      await userEvent.type(screen.getByLabelText(/Action item 2 text/i), 'Pair more');

      act(() => pending?.onSuccess?.(fullRetro({ action_items: [item('ai-new', 'Gate')] })));

      expect(screen.getByLabelText(/Action item 1 text/i)).toHaveValue('Gate deploys');
      expect(screen.getByLabelText(/Action item 2 text/i)).toHaveValue('Pair more');
      await userEvent.click(saveBtn());
      expect(saveMutateMock.mock.calls[1][0].action_items).toEqual([
        { id: 'ai-new', text: 'Gate deploys', story_points: null },
        { text: 'Pair more', story_points: null },
      ]);
    });

    it('does not duplicate a new item when the refetch lands before the save response', async () => {
      useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
      let pending: SaveOpts | undefined;
      saveMutateMock.mockImplementationOnce((_p, opts) => {
        pending = opts;
      });
      const { rerender } = renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
      await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
      await userEvent.type(screen.getByLabelText(/Action item 1 text/i), 'Gate');
      await userEvent.click(saveBtn());

      // The sprint_retro_updated refetch arrives while the POST is still pending.
      useSaveSprintRetroMock.mockReturnValue({
        mutate: saveMutateMock,
        isPending: true,
        isError: false,
        isSuccess: false,
      });
      useSprintRetroMock.mockReturnValue({
        data: fullRetro({ action_items: [item('ai-new', 'Gate')] }),
        isLoading: false,
        error: null,
      });
      rerender(<RetroPanel sprintId="sp-1" isClosed={false} />);
      act(() => pending?.onSuccess?.(fullRetro({ action_items: [item('ai-new', 'Gate')] })));
      useSaveSprintRetroMock.mockReturnValue({
        mutate: saveMutateMock,
        isPending: false,
        isError: false,
        isSuccess: true,
      });
      rerender(<RetroPanel sprintId="sp-1" isClosed={false} />);

      expect(screen.getAllByDisplayValue('Gate')).toHaveLength(1);
      await userEvent.click(saveBtn());
      expect(saveMutateMock.mock.calls[1][0].action_items).toEqual([
        { id: 'ai-new', text: 'Gate', story_points: null },
      ]);
    });

    it('adopts the new id when the server re-created an item a peer had removed', async () => {
      useSprintRetroMock.mockReturnValue({
        data: fullRetro({ action_items: [item('x-old', 'Fix CI')] }),
        isLoading: false,
        error: null,
      });
      saveMutateMock.mockImplementationOnce((_p, opts) => {
        opts?.onSuccess?.(fullRetro({ action_items: [item('x-new', 'Fix CI')] }));
      });
      renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
      await screen.findByDisplayValue('Fix CI');
      await userEvent.click(saveBtn());
      await userEvent.click(saveBtn());
      expect(saveMutateMock.mock.calls[0][0].action_items).toEqual([
        { id: 'x-old', text: 'Fix CI', story_points: null },
      ]);
      expect(saveMutateMock.mock.calls[1][0].action_items).toEqual([
        { id: 'x-new', text: 'Fix CI', story_points: null },
      ]);
    });

    it('folds in an item a peer created (e.g. a converted sticky) so the next save keeps it', async () => {
      const before = fullRetro({ action_items: [item('a1', 'Existing')] });
      useSprintRetroMock.mockReturnValue({ data: before, isLoading: false, error: null });
      const { rerender } = renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
      await screen.findByDisplayValue('Existing');

      // The retro refetch (sprint_retro_updated / convert) now carries a new item.
      useSprintRetroMock.mockReturnValue({
        data: fullRetro({ action_items: [item('a1', 'Existing'), item('c1', 'From sticky')] }),
        isLoading: false,
        error: null,
      });
      rerender(<RetroPanel sprintId="sp-1" isClosed={false} />);
      expect(await screen.findByDisplayValue('From sticky')).toBeInTheDocument();

      await userEvent.click(saveBtn());
      expect(saveMutateMock.mock.calls[0][0].action_items).toEqual([
        { id: 'a1', text: 'Existing', story_points: null },
        { id: 'c1', text: 'From sticky', story_points: null },
      ]);
    });

    it('does not bring back an item removed locally when a refetch still carries it', async () => {
      const both = fullRetro({ action_items: [item('a1', 'Keep'), item('a2', 'Drop')] });
      useSprintRetroMock.mockReturnValue({ data: both, isLoading: false, error: null });
      const { rerender } = renderWithProviders(<RetroPanel sprintId="sp-1" isClosed={false} />);
      await screen.findByDisplayValue('Drop');
      await userEvent.click(screen.getByRole('button', { name: /Remove action item 2/i }));

      useSprintRetroMock.mockReturnValue({
        data: fullRetro({ action_items: [item('a1', 'Keep'), item('a2', 'Drop')] }),
        isLoading: false,
        error: null,
      });
      rerender(<RetroPanel sprintId="sp-1" isClosed={false} />);
      expect(screen.queryByDisplayValue('Drop')).not.toBeInTheDocument();

      await userEvent.click(saveBtn());
      expect(saveMutateMock.mock.calls[0][0].action_items).toEqual([
        { id: 'a1', text: 'Keep', story_points: null },
      ]);
    });
  });
});
