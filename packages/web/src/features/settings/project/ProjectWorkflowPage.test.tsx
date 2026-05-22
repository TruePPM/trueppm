import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectWorkflowPage } from './ProjectWorkflowPage';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import type { ProjectPhase } from '@/hooks/useProjectPhases';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';

const useCurrentUserRole = vi.fn();
const useProjectPhases = vi.fn();
const useBoardConfig = vi.fn();
const useProjectCustomFields = vi.fn();

const phaseCreate = vi.fn();
const phaseUpdate = vi.fn();
const phaseRemove = vi.fn();
const phaseReorder = vi.fn();
const boardSave = vi.fn();
const fieldCreate = vi.fn();
const fieldUpdate = vi.fn();
const fieldRemove = vi.fn();

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
    color: '#1C6B3A',
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
