import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectWorkflowPage } from './ProjectWorkflowPage';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import type { ProjectPhase } from '@/hooks/useProjectPhases';
import type {
  ProjectCustomField,
  CreateCustomFieldPayload,
  UpdateCustomFieldPayload,
} from '@/hooks/useProjectCustomFields';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

const useCurrentUserRole = vi.fn();
const useProjectPhases = vi.fn();
const useBoardConfig = vi.fn();
const useProjectCustomFields = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useActiveSprint = vi.fn();
const cadenceMutate = vi.fn();

const phaseCreate = vi.fn();
const phaseUpdate = vi.fn();
const phaseRemove = vi.fn();
const phaseReorder = vi.fn();
const boardSave = vi.fn();
const fieldCreate = vi.fn<(payload: CreateCustomFieldPayload, opts?: unknown) => void>();
const fieldUpdate =
  vi.fn<(args: { id: string; payload: UpdateCustomFieldPayload }, opts?: unknown) => void>();
const fieldRemove = vi.fn<(id: string) => void>();

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));

vi.mock('@/hooks/useProjectPhases', () => ({
  useProjectPhases: () =>
    useProjectPhases() as {
      phases: ProjectPhase[];
      isLoading: boolean;
      error: Error | null;
      create: { mutate: typeof phaseCreate; isPending: boolean; error: unknown };
      update: { mutate: typeof phaseUpdate; isPending: boolean };
      remove: { mutate: typeof phaseRemove; isPending: boolean; error: unknown; variables: string | undefined };
      reorder: { mutate: typeof phaseReorder };
    },
}));

vi.mock('@/hooks/useBoardConfig', () => ({
  useBoardConfig: () =>
    useBoardConfig() as {
      columns: BoardColumnDef[];
      isLoading: boolean;
      save: typeof boardSave;
    },
  COLUMN_SLA_DEFAULTS: { BACKLOG: 14, NOT_STARTED: 7, IN_PROGRESS: 10, REVIEW: 4 },
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as { data: unknown; isLoading: boolean },
}));

vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: () => useUpdateProject() as unknown,
}));

vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => useActiveSprint() as { sprint: unknown; isLoading: boolean },
}));

vi.mock('@/hooks/useProjectCustomFields', () => ({
  useProjectCustomFields: () =>
    useProjectCustomFields() as {
      fields: ProjectCustomField[];
      isLoading: boolean;
      error: Error | null;
      create: { mutate: typeof fieldCreate; isPending: boolean; error: unknown };
      update: { mutate: typeof fieldUpdate; isPending: boolean; error: unknown };
      remove: { mutate: typeof fieldRemove; isPending: boolean };
    },
}));

function makePhase(o: Partial<ProjectPhase> = {}): ProjectPhase {
  return {
    id: 'phase-1',
    name: 'Engineering',
    color: '#3E8C6D',
    priorityRank: 10,
    wbsPath: '1',
    taskCount: 12,
    serverVersion: 1,
    ...o,
  };
}

function makeColumn(o: Partial<BoardColumnDef> = {}): BoardColumnDef {
  return {
    status: 'BACKLOG',
    label: 'Backlog',
    visible: true,
    wipLimit: null,
    color: '#94A3B8',
    ageThresholdDays: null,
    ...o,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/p1/settings/workflow']}>
        <Routes>
          <Route
            path="/projects/:projectId/settings/workflow"
            element={<ProjectWorkflowPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: Admin user (sees all controls), three phases, default board config,
  // one custom field. Tests override these as needed.
  useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
  useProjectPhases.mockReturnValue({
    phases: [
      makePhase({ id: 'p1', name: 'Engineering', taskCount: 12 }),
      makePhase({ id: 'p2', name: 'Build', taskCount: 8, color: '#7C3AED' }),
    ],
    isLoading: false,
    error: null,
    create: { mutate: phaseCreate, isPending: false, error: null },
    update: { mutate: phaseUpdate, isPending: false },
    remove: { mutate: phaseRemove, isPending: false, error: null, variables: undefined },
    reorder: { mutate: phaseReorder },
  });
  useBoardConfig.mockReturnValue({
    columns: [
      makeColumn({ status: 'BACKLOG', label: 'Backlog' }),
      makeColumn({ status: 'IN_PROGRESS', label: 'Doing', color: '#3B82F6' }),
      makeColumn({ status: 'COMPLETE', label: 'Done', color: '#22C55E' }),
    ],
    isLoading: false,
    save: boardSave,
  });
  // CadenceSection (#410): AGILE project, sprint cadence, no active sprint by default.
  useProject.mockReturnValue({
    data: { board_cadence: 'sprint', methodology: 'AGILE' },
    isLoading: false,
  });
  useUpdateProject.mockReturnValue({
    mutate: cadenceMutate,
    isPending: false,
    isError: false,
    error: null,
  });
  useActiveSprint.mockReturnValue({ sprint: null, isLoading: false });
  useProjectCustomFields.mockReturnValue({
    fields: [
      {
        id: 'f1',
        name: 'Vendor',
        fieldType: 'SINGLE_SELECT',
        required: false,
        options: [{ value: 'siemens', label: 'Siemens' }],
        order: 1,
        serverVersion: 1,
      },
    ],
    isLoading: false,
    error: null,
    create: { mutate: fieldCreate, isPending: false, error: null },
    update: { mutate: fieldUpdate, isPending: false, error: null },
    remove: { mutate: fieldRemove, isPending: false },
  });
});

describe('ProjectWorkflowPage — Phases section', () => {
  it('lists phases with their task counts', () => {
    renderPage();
    const phasesSection = screen.getByRole('region', { name: /Phases/i });
    expect(within(phasesSection).getByText('Engineering')).toBeInTheDocument();
    expect(within(phasesSection).getByText('12 tasks')).toBeInTheDocument();
    expect(within(phasesSection).getByText('8 tasks')).toBeInTheDocument();
  });

  it('add-phase button triggers create with a default name', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ Add phase/i }));
    expect(phaseCreate).toHaveBeenCalledWith({ name: 'New phase' });
  });

  it('names the inline rename field for assistive tech (issue 2199)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^Engineering$/ }));
    // The autoFocus text box would otherwise announce as an unnamed edit box.
    expect(screen.getByRole('textbox', { name: 'Rename Engineering' })).toBeInTheDocument();
  });

  it('inline rename submits a PATCH on Enter', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^Engineering$/ }));
    const input = screen.getByDisplayValue('Engineering');
    await user.clear(input);
    await user.type(input, 'Engineering & Design{Enter}');
    expect(phaseUpdate).toHaveBeenCalledWith({
      id: 'p1',
      payload: { name: 'Engineering & Design' },
    });
  });

  it('hides edit controls for MEMBER role', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    renderPage();
    expect(screen.queryByRole('button', { name: /\+ Add phase/i })).not.toBeInTheDocument();
  });

  it('shows empty state when there are no phases', () => {
    useProjectPhases.mockReturnValue({
      phases: [],
      isLoading: false,
      error: null,
      create: { mutate: phaseCreate, isPending: false, error: null },
      update: { mutate: phaseUpdate, isPending: false },
      remove: { mutate: phaseRemove, isPending: false, error: null, variables: undefined },
      reorder: { mutate: phaseReorder },
    });
    renderPage();
    expect(screen.getByText(/No phases yet/i)).toBeInTheDocument();
  });
});

describe('ProjectWorkflowPage — Statuses section', () => {
  it('renders the columns returned by useBoardConfig', () => {
    renderPage();
    const statusSection = screen.getByRole('region', { name: /Statuses/i });
    expect(within(statusSection).getByText('Backlog')).toBeInTheDocument();
    expect(within(statusSection).getByText('Doing')).toBeInTheDocument();
    expect(within(statusSection).getByText('Done')).toBeInTheDocument();
  });

  it('hides edit controls for MEMBER role and reads "Visible"/"Hidden" instead of a toggle', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    renderPage();
    expect(screen.queryByRole('button', { name: /Hide column/i })).not.toBeInTheDocument();
    expect(screen.getAllByText('Visible').length).toBeGreaterThan(0);
  });

  it('toggling visibility persists the full column array via save()', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    boardSave.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    const statusSection = screen.getByRole('region', { name: /Statuses/i });
    const hideButtons = within(statusSection).getAllByRole('button', { name: /Hide column/i });
    await user.click(hideButtons[0]);
    expect(boardSave).toHaveBeenCalled();
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.visible).toBe(false);
  });

  it('committing a per-column age limit persists ageThresholdDays via save() (#410)', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    boardSave.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    const statusSection = screen.getByRole('region', { name: /Statuses/i });
    const input = within(statusSection).getByRole('spinbutton', {
      name: /Age limit in days for Backlog/i,
    });
    await user.type(input, '6');
    await user.tab(); // blur commits
    expect(boardSave).toHaveBeenCalled();
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.ageThresholdDays).toBe(6);
  });
});

describe('ProjectWorkflowPage — Board cadence section (#410)', () => {
  it('renders both cadence options for an AGILE project', () => {
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByRole('radio', { name: /Sprint-based/i })).toBeInTheDocument();
    expect(within(region).getByRole('radio', { name: /Continuous flow/i })).toBeInTheDocument();
  });

  it('selecting Continuous flow persists board_cadence', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const user = userEvent.setup();
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    await user.click(within(region).getByRole('radio', { name: /Continuous flow/i }));
    expect(cadenceMutate).toHaveBeenCalledWith({ board_cadence: 'continuous' });
  });

  it('arrow keys move focus within the radiogroup without committing (rule 167)', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const user = userEvent.setup();
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    const sprint = within(region).getByRole('radio', { name: /Sprint-based/i });
    const continuous = within(region).getByRole('radio', { name: /Continuous flow/i });
    sprint.focus();
    await user.keyboard('{ArrowRight}');
    expect(continuous).toHaveFocus();
    // Arrow navigation moves focus only — it must NOT trigger a save.
    expect(cadenceMutate).not.toHaveBeenCalled();
  });

  it('shows the active-sprint reassurance note when continuous with an active sprint', () => {
    useProject.mockReturnValue({
      data: { board_cadence: 'continuous', methodology: 'AGILE' },
      isLoading: false,
    });
    useActiveSprint.mockReturnValue({ sprint: { id: 's1', state: 'ACTIVE' }, isLoading: false });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByText(/active sprint/i)).toBeInTheDocument();
    expect(within(region).getByText(/preserved and return/i)).toBeInTheDocument();
  });

  it('renders the cadence read-only (no radios) for a below-Scheduler MEMBER', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).queryByRole('radio')).not.toBeInTheDocument();
    expect(
      within(region).getByLabelText(
        'Board cadence: Sprint-based, managed by the project scheduler. View only.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the cadence picker for a WATERFALL project', () => {
    useProject.mockReturnValue({
      data: { board_cadence: 'sprint', methodology: 'WATERFALL' },
      isLoading: false,
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(region).getByText(/doesn.+apply/i)).toBeInTheDocument();
  });
});

describe('ProjectWorkflowPage — Fields section', () => {
  it('renders both built-in and custom fields', () => {
    renderPage();
    const fieldsSection = screen.getByRole('region', { name: /Fields/i });
    expect(within(fieldsSection).getByText('Phase')).toBeInTheDocument();
    expect(within(fieldsSection).getByText('Owner')).toBeInTheDocument();
    expect(within(fieldsSection).getByText('Critical-path')).toBeInTheDocument();
    expect(within(fieldsSection).getByText('Vendor')).toBeInTheDocument();
  });

  it('opens the create modal and submits a TEXT field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByDisplayValue('');
    await user.type(nameInput, 'Compliance gate');
    await user.click(within(dialog).getByRole('button', { name: /Add field/i }));
    expect(fieldCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Compliance gate',
        fieldType: 'TEXT',
        required: false,
      }),
      expect.any(Object),
    );
  });

  it('requires at least one option when type is SINGLE_SELECT', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByDisplayValue(''), 'Vendor');
    await user.selectOptions(
      within(dialog).getByRole('combobox'),
      'SINGLE_SELECT',
    );
    expect(within(dialog).getByRole('button', { name: /Add field/i })).toBeDisabled();
  });

  it('disables the type selector in edit mode (field_type is immutable)', async () => {
    const user = userEvent.setup();
    renderPage();
    const fieldsSection = screen.getByRole('region', { name: /Fields/i });
    await user.click(within(fieldsSection).getByRole('button', { name: /Edit Vendor/i }));
    const dialog = screen.getByRole('dialog');
    const typeSelect = within(dialog).getByRole('combobox');
    expect(typeSelect).toBeDisabled();
  });

  it('hides new-field button for MEMBER role', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    renderPage();
    expect(screen.queryByRole('button', { name: /\+ New field/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Board cadence — loading, keyboard nav, error, and no-op selection
// ---------------------------------------------------------------------------

describe('ProjectWorkflowPage — Board cadence extras', () => {
  it('renders a loading skeleton while the project is loading', () => {
    useProject.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('clicking the already-selected cadence does not persist', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const user = userEvent.setup();
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    // Sprint is already selected by default — re-clicking must not mutate.
    await user.click(within(region).getByRole('radio', { name: /Sprint-based/i }));
    expect(cadenceMutate).not.toHaveBeenCalled();
  });

  it('ArrowLeft/Home/End move focus within the radiogroup without committing', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const user = userEvent.setup();
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    const sprint = within(region).getByRole('radio', { name: /Sprint-based/i });
    const continuous = within(region).getByRole('radio', { name: /Continuous flow/i });

    continuous.focus();
    await user.keyboard('{Home}');
    expect(sprint).toHaveFocus();

    await user.keyboard('{End}');
    expect(continuous).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(sprint).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(sprint).toHaveFocus(); // clamped at index 0

    // A non-navigation key is ignored (no focus change, no commit).
    await user.keyboard('a');
    expect(sprint).toHaveFocus();
    expect(cadenceMutate).not.toHaveBeenCalled();
  });

  it('keyboard navigation is inert for a read-only viewer', async () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    const user = userEvent.setup();
    renderPage();
    // No radiogroup rendered at all for a viewer, so nothing to key through.
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).queryByRole('radiogroup')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(cadenceMutate).not.toHaveBeenCalled();
  });

  it('shows a server error detail when the cadence update fails', () => {
    useUpdateProject.mockReturnValue({
      mutate: cadenceMutate,
      isPending: false,
      isError: true,
      error: { response: { data: { detail: 'Board is locked' } } },
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByText('Board is locked')).toBeInTheDocument();
  });

  it('falls back to a generic message when the error has no detail', () => {
    useUpdateProject.mockReturnValue({
      mutate: cadenceMutate,
      isPending: false,
      isError: true,
      error: {},
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByText('Could not update board cadence.')).toBeInTheDocument();
  });

  it('surfaces a raw string error body from the server', () => {
    useUpdateProject.mockReturnValue({
      mutate: cadenceMutate,
      isPending: false,
      isError: true,
      error: { response: { data: 'Service Unavailable' } },
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByText('Service Unavailable')).toBeInTheDocument();
  });

  it('surfaces a per-field string error when there is no top-level detail', () => {
    useUpdateProject.mockReturnValue({
      mutate: cadenceMutate,
      isPending: false,
      isError: true,
      error: { response: { data: { board_cadence: 'Invalid choice' } } },
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByText('Invalid choice')).toBeInTheDocument();
  });

  it('disables cadence radios while an update is pending', () => {
    useUpdateProject.mockReturnValue({
      mutate: cadenceMutate,
      isPending: true,
      isError: false,
      error: null,
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Board cadence/i });
    expect(within(region).getByRole('radio', { name: /Sprint-based/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// PhaseRow — color picker, delete, rename revert, delete error
// ---------------------------------------------------------------------------

describe('ProjectWorkflowPage — PhaseRow interactions', () => {
  it('recolors a phase through the swatch picker', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Change color for Engineering/i }));
    await user.click(screen.getByRole('button', { name: /Set phase color to Violet/i }));
    expect(phaseUpdate).toHaveBeenCalledWith({ id: 'p1', payload: { color: '#7C3AED' } });
  });

  it('clears a phase color to inherit the default', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Change color for Engineering/i }));
    const picker = screen.getByRole('button', { name: /Set phase color to Sage/i }).parentElement!;
    await user.click(within(picker).getByRole('button', { name: /^Clear$/ }));
    expect(phaseUpdate).toHaveBeenCalledWith({ id: 'p1', payload: { color: null } });
  });

  it('deletes a phase', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Delete phase Engineering/i }));
    expect(phaseRemove).toHaveBeenCalledWith('p1');
  });

  it('reverts an unchanged rename on blur without a PATCH', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^Engineering$/ }));
    const input = screen.getByDisplayValue('Engineering');
    await user.tab(); // blur with no change
    expect(phaseUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Engineering$/ })).toBeInTheDocument();
    expect(input).not.toBeInTheDocument();
  });

  it('Escape cancels an in-flight rename', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /^Engineering$/ }));
    const input = screen.getByDisplayValue('Engineering');
    await user.clear(input);
    await user.type(input, 'Discarded{Escape}');
    expect(phaseUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Engineering$/ })).toBeInTheDocument();
  });

  it('surfaces a delete error inline for the failed phase only', () => {
    useProjectPhases.mockReturnValue({
      phases: [makePhase({ id: 'p1', name: 'Engineering', taskCount: 12 })],
      isLoading: false,
      error: null,
      create: { mutate: phaseCreate, isPending: false, error: null },
      update: { mutate: phaseUpdate, isPending: false },
      remove: {
        mutate: phaseRemove,
        isPending: false,
        error: { response: { data: { detail: 'Phase has tasks' } } },
        variables: 'p1',
      },
      reorder: { mutate: phaseReorder },
    });
    renderPage();
    expect(screen.getByText('Phase has tasks')).toBeInTheDocument();
  });

  it('shows a loading placeholder for phases', () => {
    useProjectPhases.mockReturnValue({
      phases: [],
      isLoading: true,
      error: null,
      create: { mutate: phaseCreate, isPending: false, error: null },
      update: { mutate: phaseUpdate, isPending: false },
      remove: { mutate: phaseRemove, isPending: false, error: null, variables: undefined },
      reorder: { mutate: phaseReorder },
    });
    renderPage();
    const region = screen.getByRole('region', { name: /Phases/i });
    expect(within(region).getByText('Loading…')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// StatusRow — color picker, age threshold commit branches, label edit
// ---------------------------------------------------------------------------

describe('ProjectWorkflowPage — StatusRow interactions', () => {
  beforeEach(() => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    boardSave.mockResolvedValue(undefined);
  });

  it('recolors a status column through the swatch picker', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    await user.click(within(section).getByRole('button', { name: /Change color for Backlog/i }));
    await user.click(within(section).getByRole('button', { name: /Set status color to Red/i }));
    expect(boardSave).toHaveBeenCalled();
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.color).toBe('#DC2626');
  });

  it('clears a status color to null', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    await user.click(within(section).getByRole('button', { name: /Change color for Backlog/i }));
    const picker = within(section)
      .getByRole('button', { name: /Set status color to Sage/i })
      .parentElement!;
    await user.click(within(picker).getByRole('button', { name: /^Clear$/ }));
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.color).toBeNull();
  });

  it('renames a status column and persists the new label', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    await user.click(within(section).getByRole('button', { name: /^Backlog$/ }));
    const input = screen.getByDisplayValue('Backlog');
    await user.clear(input);
    await user.type(input, 'Intake{Enter}');
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.label).toBe('Intake');
  });

  it('Escape abandons a status rename without saving', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    await user.click(within(section).getByRole('button', { name: /^Backlog$/ }));
    const input = screen.getByDisplayValue('Backlog');
    await user.type(input, 'X{Escape}');
    expect(boardSave).not.toHaveBeenCalled();
    expect(within(section).getByRole('button', { name: /^Backlog$/ })).toBeInTheDocument();
  });

  it('clearing an existing age threshold persists null', async () => {
    useBoardConfig.mockReturnValue({
      columns: [makeColumn({ status: 'BACKLOG', label: 'Backlog', ageThresholdDays: 5 })],
      isLoading: false,
      save: boardSave,
    });
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByRole('spinbutton', { name: /Age limit in days for Backlog/i });
    await user.clear(input);
    await user.tab();
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.ageThresholdDays).toBeNull();
  });

  it('reverts an invalid (zero) age entry instead of persisting garbage', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByRole('spinbutton', { name: /Age limit in days for Backlog/i });
    await user.type(input, '0');
    await user.tab();
    expect(boardSave).not.toHaveBeenCalled();
    expect(input).toHaveValue(null); // reverted to the empty (inherit) state
  });

  it('commits a valid age threshold on Enter', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByRole('spinbutton', { name: /Age limit in days for Backlog/i });
    await user.type(input, '12{Enter}');
    const next = boardSave.mock.calls[0][0] as BoardColumnDef[];
    expect(next.find((c) => c.status === 'BACKLOG')?.ageThresholdDays).toBe(12);
  });

  it('Escape reverts the age draft without committing', async () => {
    useBoardConfig.mockReturnValue({
      columns: [makeColumn({ status: 'BACKLOG', label: 'Backlog', ageThresholdDays: 5 })],
      isLoading: false,
      save: boardSave,
    });
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByRole('spinbutton', { name: /Age limit in days for Backlog/i });
    await user.clear(input);
    await user.type(input, '99{Escape}');
    expect(boardSave).not.toHaveBeenCalled();
    expect(input).toHaveValue(5); // reverted to the saved threshold
  });

  it('shows the board loading state', () => {
    useBoardConfig.mockReturnValue({ columns: [], isLoading: true, save: boardSave });
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    expect(within(section).getByText('Loading…')).toBeInTheDocument();
  });

  it('read-only viewers see the resolved default age, not an input', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    useBoardConfig.mockReturnValue({
      columns: [makeColumn({ status: 'BACKLOG', label: 'Backlog', ageThresholdDays: null })],
      isLoading: false,
      save: boardSave,
    });
    renderPage();
    const section = screen.getByRole('region', { name: /Statuses/i });
    // COLUMN_SLA_DEFAULTS.BACKLOG === 14 from the mock.
    expect(within(section).getByText('14d')).toBeInTheDocument();
    expect(
      within(section).queryByRole('spinbutton', { name: /Age limit/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fields — remove, edit modal, and the custom-field modal internals
// ---------------------------------------------------------------------------

describe('ProjectWorkflowPage — Fields extras', () => {
  it('deletes a custom field', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Fields/i });
    await user.click(within(section).getByRole('button', { name: /Delete Vendor/i }));
    expect(fieldRemove).toHaveBeenCalledWith('f1');
  });

  it('shows a loading row while custom fields load', () => {
    useProjectCustomFields.mockReturnValue({
      fields: [],
      isLoading: true,
      error: null,
      create: { mutate: fieldCreate, isPending: false, error: null },
      update: { mutate: fieldUpdate, isPending: false, error: null },
      remove: { mutate: fieldRemove, isPending: false },
    });
    renderPage();
    expect(screen.getByText(/Loading custom fields/i)).toBeInTheDocument();
  });

  it('canceling the create modal closes it without submitting', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fieldCreate).not.toHaveBeenCalled();
  });

  it('toggling Required and choosing NUMBER submits the expected payload', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByDisplayValue(''), 'Cost');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'NUMBER');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: /Add field/i }));
    expect(fieldCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cost',
        fieldType: 'NUMBER',
        required: true,
        options: [],
      }),
      expect.any(Object),
    );
  });

  it('edits an existing custom field and submits name/required/options', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = screen.getByRole('region', { name: /Fields/i });
    await user.click(within(section).getByRole('button', { name: /Edit Vendor/i }));
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByDisplayValue('Vendor');
    await user.clear(nameInput);
    await user.type(nameInput, 'Supplier');
    await user.click(within(dialog).getByRole('button', { name: /^Save$/i }));
    const [updateArg] = fieldUpdate.mock.calls[0];
    expect(updateArg.id).toBe('f1');
    expect(updateArg.payload).toMatchObject({ name: 'Supplier', required: false });
  });

  it('shows a submit error inside the create modal', async () => {
    useProjectCustomFields.mockReturnValue({
      fields: [],
      isLoading: false,
      error: null,
      create: {
        mutate: fieldCreate,
        isPending: false,
        error: { response: { data: { name: ['A field with this name exists'] } } },
      },
      update: { mutate: fieldUpdate, isPending: false, error: null },
      remove: { mutate: fieldRemove, isPending: false },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    expect(screen.getByText('A field with this name exists')).toBeInTheDocument();
  });

  it('a form submit while the name is empty is a no-op (guarded)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    // Submit the form via Enter in the empty name field — canSubmit is false,
    // so submit() must return without calling create.
    const nameInput = within(dialog).getByRole('textbox');
    nameInput.focus();
    await user.keyboard('{Enter}');
    expect(fieldCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows "Saving…" and disables submit while a create is pending', async () => {
    useProjectCustomFields.mockReturnValue({
      fields: [],
      isLoading: false,
      error: null,
      create: { mutate: fieldCreate, isPending: true, error: null },
      update: { mutate: fieldUpdate, isPending: false, error: null },
      remove: { mutate: fieldRemove, isPending: false },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByDisplayValue(''), 'Anything');
    expect(within(dialog).getByRole('button', { name: /Saving…/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// OptionsEditor — add / update / remove option rows (SINGLE_SELECT flow)
// ---------------------------------------------------------------------------

describe('ProjectWorkflowPage — OptionsEditor', () => {
  it('adds, edits, and removes options for a select-type field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByDisplayValue(''), 'Region');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'MULTI_SELECT');

    // Empty-options hint is visible and submit is blocked.
    expect(within(dialog).getByText(/No options yet/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Add field/i })).toBeDisabled();

    // Add one option row, then fill its label.
    await user.click(within(dialog).getByRole('button', { name: /\+ Add option/i }));
    const labelInput = within(dialog).getByRole('textbox', { name: /Option 1 label/i });
    await user.type(labelInput, 'North');
    expect(within(dialog).getByRole('button', { name: /Add field/i })).toBeEnabled();

    // Add a second, edit its value, then remove the first.
    await user.click(within(dialog).getByRole('button', { name: /\+ Add option/i }));
    const value2 = within(dialog).getByRole('textbox', { name: /Option 2 value/i });
    await user.clear(value2);
    await user.type(value2, 'south');
    await user.click(within(dialog).getByRole('button', { name: /Remove option option-1/i }));
    expect(within(dialog).queryByRole('textbox', { name: /Option 2 value/i })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Add field/i }));
    const [payload] = fieldCreate.mock.calls[0];
    expect(payload.fieldType).toBe('MULTI_SELECT');
    expect(payload.options).toHaveLength(1);
    expect(payload.options?.[0]?.value).toBe('south');
  });

  it('switching a select type back to a scalar type discards options', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /\+ New field/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByDisplayValue(''), 'Flag');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'SINGLE_SELECT');
    await user.click(within(dialog).getByRole('button', { name: /\+ Add option/i }));
    expect(within(dialog).getByRole('textbox', { name: /Option 1 value/i })).toBeInTheDocument();

    // Switch to BOOLEAN — the options editor disappears and options are cleared.
    await user.selectOptions(within(dialog).getByRole('combobox'), 'BOOLEAN');
    expect(within(dialog).queryByRole('textbox', { name: /Option 1 value/i })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Add field/i }));
    const [payload] = fieldCreate.mock.calls[0];
    expect(payload.fieldType).toBe('BOOLEAN');
    expect(payload.options).toEqual([]);
  });
});
