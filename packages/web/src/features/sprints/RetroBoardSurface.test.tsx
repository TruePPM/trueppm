import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { RetroBoardColumnKey, RetroBoardResponse } from '@/hooks/useRetroBoard';
import type {
  SprintRetroPayload,
  SprintRetroSummaryPayload,
  SprintRetroResponse,
} from '@/hooks/useSprints';
import { RetroBoardSurface } from './RetroBoardSurface';

// ---------------------------------------------------------------------------
// Hoisted mock state — mutation objects + query fns the surface consumes.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  useSprintRetro: vi.fn<() => { data: SprintRetroResponse | null }>(),
  useSprintRetroPrior: vi.fn<() => { data: SprintRetroResponse | null }>(),
  useRetroBoard: vi.fn<() => { data: RetroBoardResponse }>(),
  save: { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false },
  updateVisibility: { mutate: vi.fn(), isPending: false },
  promote: { mutate: vi.fn(), isPending: false, isError: false },
  createItem: { mutate: vi.fn() },
  updateItem: { mutate: vi.fn() },
  deleteItem: { mutate: vi.fn() },
  convert: { mutate: vi.fn(), isPending: false, variables: undefined as string | undefined },
  wsState: 'connected' as string,
}));

vi.mock('@/hooks/useSprints', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/useSprints')>();
  return {
    ...actual, // keep the real isFullRetro type-guard
    useSprintRetro: () => mocks.useSprintRetro(),
    useSprintRetroPrior: () => mocks.useSprintRetroPrior(),
    useSaveSprintRetro: () => mocks.save,
    useUpdateRetroVisibility: () => mocks.updateVisibility,
    usePromoteRetroActionItem: () => mocks.promote,
  };
});

vi.mock('@/hooks/useRetroBoard', () => ({
  useRetroBoard: () => mocks.useRetroBoard(),
  useCreateBoardItem: () => mocks.createItem,
  useUpdateBoardItem: () => mocks.updateItem,
  useDeleteBoardItem: () => mocks.deleteItem,
  useConvertStickyToAction: () => mocks.convert,
}));

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    lower: 'sprint',
    singular: 'sprint',
    title: 'Sprint',
    Title: 'Sprint',
    plural: 'sprints',
    pluralTitle: 'Sprints',
  }),
}));

vi.mock('@/stores/wsConnectionStore', () => ({
  useWsConnectionStore: (sel: (s: { state: string }) => unknown) => sel({ state: mocks.wsState }),
}));

// ---------------------------------------------------------------------------
// Presentational child stubs — expose the surface's callbacks + passed props so
// we can drive the container's orchestration (optimistic pending, LWW toast,
// mutation wiring) deterministically.
// ---------------------------------------------------------------------------
interface HeaderProps {
  visibility: string | null;
  canEditVisibility: boolean;
  visibilityPending: boolean;
  offline: boolean;
  onChangeVisibility: (v: 'project') => void;
}
vi.mock('./RetroBoardHeader', () => ({
  RetroBoardHeader: (p: HeaderProps) => (
    <div data-testid="board-header">
      <h2 id="retro-panel-heading">Retrospective</h2>
      <span>vis:{String(p.visibility)}</span>
      {p.offline && <span>offline-indicator</span>}
      {p.canEditVisibility && <span>can-edit-vis</span>}
      {p.visibilityPending && <span>vis-pending</span>}
      <button onClick={() => p.onChangeVisibility('project')}>change-vis</button>
    </div>
  ),
}));

interface ColumnsProps {
  items: { id: string }[];
  pending: { tempId: string; column: RetroBoardColumnKey; text: string; failed: boolean }[];
  remoteIds: Set<string>;
  readOnly: boolean;
  convertingId: string | null;
  onAdd: (c: RetroBoardColumnKey, t: string) => void;
  onEdit: (id: string, t: string) => void;
  onDelete: (id: string) => void;
  onConvert: (id: string) => void;
  onRetry: (t: string) => void;
  onDiscard: (t: string) => void;
}
vi.mock('./RetroColumns', () => ({
  RetroColumns: (p: ColumnsProps) => (
    <div data-testid="retro-columns">
      <span>items:{p.items.length}</span>
      <span>pending:{p.pending.length}</span>
      <span>remote:{p.remoteIds.size}</span>
      <span>readonly:{String(p.readOnly)}</span>
      <span>converting:{String(p.convertingId)}</span>
      {p.pending.map((pn) => (
        <span key={pn.tempId} data-testid="pending-item">
          {pn.column}|{pn.text}|{String(pn.failed)}
        </span>
      ))}
      <button onClick={() => p.onAdd('went_well', 'new sticky')}>add-sticky</button>
      <button onClick={() => p.onEdit('item-1', 'edited text')}>edit-sticky</button>
      <button onClick={() => p.onDelete('item-1')}>delete-sticky</button>
      <button onClick={() => p.onConvert('item-1')}>convert-sticky</button>
      <button onClick={() => p.onRetry(p.pending[0]?.tempId ?? '')}>retry-sticky</button>
      <button onClick={() => p.onDiscard(p.pending[0]?.tempId ?? '')}>discard-sticky</button>
    </div>
  ),
}));

vi.mock('./PriorRetroSection', () => ({
  PriorRetroSection: (p: { prior: unknown }) => <div>prior:{String(p.prior !== null)}</div>,
}));

vi.mock('./RetroSummaryCard', () => ({
  RetroSummaryCard: () => <div>summary-card</div>,
}));

vi.mock('./RetroNotes', () => ({
  RetroNotes: (p: { notes: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="notes-stub"
      value={p.notes}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}));

interface ActionItemsProps {
  items: { text: string; story_points: string }[];
  savePending: boolean;
  promotePending: boolean;
  onAdd: () => void;
  onUpdate: (i: number, patch: { text?: string; story_points?: string }) => void;
  onRemove: (i: number) => void;
  onPromote: (id: string) => void;
}
vi.mock('./RetroActionItems', () => ({
  RetroActionItems: (p: ActionItemsProps) => (
    <div data-testid="action-items">
      <span>action-count:{p.items.length}</span>
      <span>save-pending:{String(p.savePending)}</span>
      <button onClick={p.onAdd}>add-action</button>
      <button onClick={() => p.onUpdate(0, { text: 'Updated action' })}>update-action</button>
      <button onClick={() => p.onRemove(0)}>remove-action</button>
      <button onClick={() => p.onPromote('ai-1')}>promote-action</button>
    </div>
  ),
}));

vi.mock('./TeamHealthPulse', () => ({
  TeamHealthPulse: (p: { canRespond: boolean }) => (
    <div>pulse-canRespond:{String(p.canRespond)}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
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

function boardData(itemIds: string[] = []): RetroBoardResponse {
  return {
    columns: [
      { key: 'went_well', label: 'Went well' },
      { key: 'to_improve', label: 'To improve' },
      { key: 'ideas', label: 'Ideas' },
    ],
    items: itemIds.map((id) => ({
      id,
      retro: 'r1',
      column: 'went_well' as const,
      text: 'original',
      author: 1,
      author_username: 'Ada',
      position: 1,
      color: '',
      converted_action_item_id: null,
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useSprintRetro.mockReturnValue({ data: fullRetro() });
  mocks.useSprintRetroPrior.mockReturnValue({ data: null });
  mocks.useRetroBoard.mockReturnValue({ data: boardData() });
  mocks.save.isPending = false;
  mocks.save.isError = false;
  mocks.save.isSuccess = false;
  mocks.updateVisibility.isPending = false;
  mocks.promote.isPending = false;
  mocks.promote.isError = false;
  mocks.convert.isPending = false;
  mocks.convert.variables = undefined;
  mocks.wsState = 'connected';
});

describe('RetroBoardSurface — below-threshold summary branch', () => {
  it('renders the counts-only summary card (not the live board) when the retro is a summary payload', () => {
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
    mocks.useSprintRetro.mockReturnValue({ data: summary });
    mocks.useSprintRetroPrior.mockReturnValue({ data: fullRetro() });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);

    expect(screen.getByRole('heading', { level: 2, name: /Retrospective/i })).toBeInTheDocument();
    expect(screen.getByText('summary-card')).toBeInTheDocument();
    expect(screen.getByText('prior:true')).toBeInTheDocument();
    // The live board never renders below the visibility threshold.
    expect(screen.queryByTestId('retro-columns')).not.toBeInTheDocument();
  });
});

describe('RetroBoardSurface — lifecycle gating', () => {
  it('PLANNED sprint shows the "opens when active" notice and hides the board, actions, and pulse', () => {
    renderWithProviders(
      <RetroBoardSurface sprintId="sp-1" isClosed={false} sprintState="PLANNED" />,
    );
    expect(screen.getByText(/The retro board opens when this sprint is active\./i)).toBeInTheDocument();
    expect(screen.queryByTestId('retro-columns')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-items')).not.toBeInTheDocument();
    expect(screen.queryByText(/pulse-canRespond/)).not.toBeInTheDocument();
  });

  it('CANCELLED sprint renders read-only board + gated pulse and a canceled notice', () => {
    renderWithProviders(
      <RetroBoardSurface sprintId="sp-1" isClosed={false} sprintState="CANCELLED" />,
    );
    expect(screen.getByText(/was canceled — the retro is read-only/i)).toBeInTheDocument();
    expect(screen.getByText('readonly:true')).toBeInTheDocument();
    expect(screen.getByText('pulse-canRespond:false')).toBeInTheDocument();
    // Save is disabled on a canceled retro.
    expect(screen.getByRole('button', { name: /Save notes & actions/i })).toBeDisabled();
  });

  it('ACTIVE (default from isClosed=false) renders a writable board + respondable pulse', () => {
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('readonly:false')).toBeInTheDocument();
    expect(screen.getByText('pulse-canRespond:true')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save notes & actions/i })).toBeEnabled();
  });

  it('falls back to COMPLETED (editable) when isClosed and no explicit sprintState', () => {
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={true} />);
    expect(screen.getByText('readonly:false')).toBeInTheDocument();
    expect(screen.getByText(/still editable — retros can be amended after close/i)).toBeInTheDocument();
  });
});

describe('RetroBoardSurface — header + connection state', () => {
  it('passes offline=true to the header when the WS connection is stale', () => {
    mocks.wsState = 'stale';
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('offline-indicator')).toBeInTheDocument();
  });

  it('passes offline=true when the WS connection has failed', () => {
    mocks.wsState = 'failed';
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('offline-indicator')).toBeInTheDocument();
  });

  it('is not offline on a healthy connection', () => {
    mocks.wsState = 'connected';
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.queryByText('offline-indicator')).not.toBeInTheDocument();
  });

  it('surfaces the edit-visibility affordance and fires the mutation on change', async () => {
    renderWithProviders(
      <RetroBoardSurface sprintId="sp-1" isClosed={false} canEditVisibility />,
    );
    expect(screen.getByText('can-edit-vis')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'change-vis' }));
    expect(mocks.updateVisibility.mutate).toHaveBeenCalledWith('project');
  });
});

describe('RetroBoardSurface — remote-add tracking', () => {
  it('flags server items that were not created locally as remote (for the enter animation)', () => {
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1', 'item-2']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('remote:2')).toBeInTheDocument();
    expect(screen.getByText('items:2')).toBeInTheDocument();
  });
});

describe('RetroBoardSurface — optimistic sticky create', () => {
  it('adds a pending placeholder immediately and clears it on server success', async () => {
    mocks.createItem.mutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (c: { id: string }) => void }) => {
        opts.onSuccess({ id: 'server-1' });
      },
    );
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'add-sticky' }));
    // onSuccess ran synchronously inside the click, so the placeholder is gone.
    expect(screen.getByText('pending:0')).toBeInTheDocument();
    expect(mocks.createItem.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ column: 'went_well', text: 'new sticky' }),
      expect.any(Object),
    );
  });

  it('keeps the placeholder visible while the create is in flight', async () => {
    mocks.createItem.mutate.mockImplementation(() => {
      /* never resolves — stays pending */
    });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'add-sticky' }));
    expect(screen.getByText('pending:1')).toBeInTheDocument();
    expect(screen.getByTestId('pending-item')).toHaveTextContent('went_well|new sticky|false');
  });

  it('marks the placeholder failed on error, then a retry re-fires and succeeds', async () => {
    mocks.createItem.mutate.mockImplementationOnce(
      (_vars: unknown, opts: { onError: () => void }) => {
        opts.onError();
      },
    );
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'add-sticky' }));
    expect(screen.getByTestId('pending-item')).toHaveTextContent('went_well|new sticky|true');

    mocks.createItem.mutate.mockImplementationOnce(
      (_vars: unknown, opts: { onSuccess: (c: { id: string }) => void }) => {
        opts.onSuccess({ id: 'server-1' });
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'retry-sticky' }));
    expect(screen.getByText('pending:0')).toBeInTheDocument();
    expect(mocks.createItem.mutate).toHaveBeenCalledTimes(2);
  });

  it('discards a pending placeholder without a network call', async () => {
    mocks.createItem.mutate.mockImplementation(() => {
      /* stays pending */
    });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'add-sticky' }));
    expect(screen.getByText('pending:1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'discard-sticky' }));
    expect(screen.getByText('pending:0')).toBeInTheDocument();
  });
});

describe('RetroBoardSurface — sticky edit / LWW reconcile', () => {
  it('shows the "updated by a teammate" toast and re-applies the local text on Undo', async () => {
    mocks.updateItem.mutate.mockImplementation(
      (
        _vars: unknown,
        opts?: { onSettled?: (d: { text: string; author_username: string }) => void },
      ) => {
        opts?.onSettled?.({ text: 'peer version', author_username: 'Dana' });
      },
    );
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'edit-sticky' }));
    expect(screen.getByText(/This card was updated by Dana — your version was replaced\./i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // The last mutate call re-applies our local text.
    expect(mocks.updateItem.mutate).toHaveBeenLastCalledWith({ id: 'item-1', text: 'edited text' });
    // Toast dismisses after Undo.
    expect(screen.queryByText(/your version was replaced/i)).not.toBeInTheDocument();
  });

  it('does NOT show the reconcile toast when the server echoes our own text back', async () => {
    mocks.updateItem.mutate.mockImplementation(
      (_vars: unknown, opts?: { onSettled?: (d: { text: string }) => void }) => {
        opts?.onSettled?.({ text: 'edited text' });
      },
    );
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'edit-sticky' }));
    expect(screen.queryByText(/your version was replaced/i)).not.toBeInTheDocument();
  });
});

describe('RetroBoardSurface — delete / convert', () => {
  it('deletes a sticky via the delete mutation', async () => {
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'delete-sticky' }));
    expect(mocks.deleteItem.mutate).toHaveBeenCalledWith('item-1');
  });

  it('converts a sticky into an action item', async () => {
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'convert-sticky' }));
    expect(mocks.convert.mutate).toHaveBeenCalledWith('item-1');
  });

  it('passes the in-flight convert id down so the matching card can show a busy state', () => {
    mocks.convert.isPending = true;
    mocks.convert.variables = 'item-1';
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('converting:item-1')).toBeInTheDocument();
  });

  it('passes convertingId=null when no convert is in flight', () => {
    mocks.useRetroBoard.mockReturnValue({ data: boardData(['item-1']) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('converting:null')).toBeInTheDocument();
  });
});

describe('RetroBoardSurface — single-author notes & action items', () => {
  it('hydrates from the retro and saves trimmed notes plus mapped action items', async () => {
    mocks.useSprintRetro.mockReturnValue({
      data: fullRetro({
        notes: '  Burndown skewed  ',
        action_items: [
          {
            id: 'ai-1',
            text: 'Add deploy gate',
            assignee: null,
            assignee_username: null,
            story_points: 3,
            promoted_task_id: null,
            created_at: '2026-04-15T00:00:00Z',
          },
          {
            id: 'ai-2',
            text: 'Pair on billing',
            assignee: null,
            assignee_username: null,
            story_points: null,
            promoted_task_id: null,
            created_at: '2026-04-15T00:00:00Z',
          },
        ],
      }),
    });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText('action-count:2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Save notes & actions/i }));
    expect(mocks.save.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.save.mutate).toHaveBeenCalledWith({
      notes: 'Burndown skewed',
      action_items: [
        { text: 'Add deploy gate', story_points: 3 },
        { text: 'Pair on billing', story_points: null },
      ],
    });
  });

  it('filters out an empty (blank-text) draft action item on save', async () => {
    mocks.useSprintRetro.mockReturnValue({ data: fullRetro({ notes: '' }) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    // Add a blank draft item, then save.
    await userEvent.click(screen.getByRole('button', { name: 'add-action' }));
    expect(screen.getByText('action-count:1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Save notes & actions/i }));
    expect(mocks.save.mutate).toHaveBeenCalledWith({ notes: '', action_items: [] });
  });

  it('promotes a persisted action item through the promote mutation', async () => {
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'promote-action' }));
    expect(mocks.promote.mutate).toHaveBeenCalledWith('ai-1');
  });

  it('shows the saving state on the button while a save is pending', () => {
    mocks.save.isPending = true;
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    const btn = screen.getByRole('button', { name: /Saving…/i });
    expect(btn).toBeDisabled();
  });

  it('surfaces the save-error alert', () => {
    mocks.save.isError = true;
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to save retro/i);
  });

  it('surfaces the saved-confirmation status', () => {
    mocks.save.isSuccess = true;
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    expect(screen.getByText(/Retro saved\./i)).toBeInTheDocument();
  });

  it('surfaces the promote-error alert', () => {
    mocks.promote.isError = true;
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /Failed to promote item/i.test(a.textContent ?? ''))).toBe(true);
  });

  it('lets the user edit the notes field (onChange wiring)', async () => {
    mocks.useSprintRetro.mockReturnValue({ data: fullRetro({ notes: 'start' }) });
    renderWithProviders(<RetroBoardSurface sprintId="sp-1" isClosed={false} />);
    const field = screen.getByLabelText('notes-stub');
    expect(field).toHaveValue('start');
    await userEvent.clear(field);
    await userEvent.type(field, 'updated notes');
    expect(field).toHaveValue('updated notes');
  });
});
