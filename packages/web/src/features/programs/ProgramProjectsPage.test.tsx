import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramProjectsPage } from './ProgramProjectsPage';
import type { Project } from '@/types';
import { ROLE_VIEWER } from '@/lib/roles';

const useProgram = vi.fn();
const useProgramProjects = vi.fn();
const refetchProjects = vi.fn();
const removeMutateAsync =
  vi.fn<(args: { projectId: string; programId: string | null }) => Promise<unknown>>();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));

const mockNavigate = vi.fn<(to: string) => void>();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// The row pin toggle (#2390) owns its own mutation; stub it so these tests stay
// about the list, not about react-query wiring.
vi.mock('@/hooks/usePins', () => ({
  useTogglePin: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () =>
    useProgramProjects() as {
      data: Project[] | undefined;
      isLoading: boolean;
      error: unknown;
      refetch: () => void;
    },
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useAssignProjectToProgram: () => ({ mutateAsync: removeMutateAsync, isPending: false }),
}));
// The three creation modals are stubbed so their module trees don't drag heavy
// deps into the unit test. Each stub echoes the `programName` it was handed and
// exposes the callbacks the page wires to it, so the open → close / open →
// created → navigate contract is observable without the real dialogs.
interface CreateModalStubProps {
  programId?: string;
  programName?: string;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

vi.mock('@/features/shell/NewProjectModal', () => ({
  NewProjectModal: ({ programName, onClose, onCreated }: CreateModalStubProps) => (
    <div role="dialog" aria-label="New project modal">
      <p>new-project program: {programName ?? '(unnamed)'}</p>
      <button type="button" onClick={() => onCreated('created-1')}>
        Finish new project
      </button>
      <button type="button" onClick={onClose}>
        Close new project
      </button>
    </div>
  ),
}));
vi.mock('@/components/import/ImportProjectModal', () => ({
  ImportProjectModal: ({ programName, onClose, onCreated }: CreateModalStubProps) => (
    <div role="dialog" aria-label="Import project modal">
      <p>import program: {programName ?? '(unnamed)'}</p>
      <button type="button" onClick={() => onCreated('imported-1')}>
        Finish import
      </button>
      <button type="button" onClick={onClose}>
        Close import
      </button>
    </div>
  ),
}));
vi.mock('./AddProjectToProgramModal', () => ({
  AddProjectToProgramModal: ({
    programName,
    onClose,
  }: {
    programId: string;
    programName: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Add existing project modal">
      <p>add-existing program: {programName === '' ? '(unnamed)' : programName}</p>
      <button type="button" onClick={onClose}>
        Close add existing
      </button>
    </div>
  ),
}));

function proj(overrides: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    colorDot: '#6B6965',
    healthState: 'unknown',
    openTaskCount: null,
    methodology: 'HYBRID',
    programId: 'prog-1',
    ...overrides,
  };
}

/** Mounts the page on a route that carries no `:programId` at all. */
function renderWithoutProgramId() {
  return render(
    <MemoryRouter initialEntries={['/programs']}>
      <Routes>
        <Route path="/programs" element={<ProgramProjectsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderPage(entry = '/programs/prog-1/projects') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/programs/:programId/projects" element={<ProgramProjectsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProgramProjectsPage rollup surfacing (#560)', () => {
  beforeEach(() => {
    refetchProjects.mockReset();
    removeMutateAsync.mockReset();
    removeMutateAsync.mockResolvedValue(undefined);
    useProgram.mockReturnValue({
      data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER, target_date: '2026-09-30' },
    });
    useProgramProjects.mockReturnValue({
      data: [
        proj({ id: 'a', name: 'Alpha', overdueCount: 2, atRiskCount: 1 }),
        proj({ id: 'b', name: 'Bravo', overdueCount: 0, atRiskCount: 0 }),
      ],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
  });

  it('renders the program target date in the header', () => {
    renderPage();
    expect(screen.getByText(/Target/)).toBeInTheDocument();
  });

  it('omits the target line when the program has no target date', () => {
    useProgram.mockReturnValue({
      data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER, target_date: null },
    });
    renderPage();
    expect(screen.queryByText(/Target/)).not.toBeInTheDocument();
  });

  it('renders overdue + at-risk chips with accessible labels when counts are non-zero', () => {
    renderPage();
    const alpha = screen.getByText('Alpha').closest('li') as HTMLElement;
    expect(within(alpha).getByText('2 overdue')).toHaveAttribute('aria-label', '2 overdue tasks');
    expect(within(alpha).getByText('1 at risk')).toHaveAttribute('aria-label', '1 at-risk task');
  });

  it('omits chips on a project with zero overdue / at-risk', () => {
    renderPage();
    const bravo = screen.getByText('Bravo').closest('li') as HTMLElement;
    expect(within(bravo).queryByText(/overdue/)).not.toBeInTheDocument();
    expect(within(bravo).queryByText(/at risk/)).not.toBeInTheDocument();
  });
});

describe('ProgramProjectsPage KPI drill-through sort (#2155)', () => {
  beforeEach(() => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER } });
    // Server order is start_date/name; the KPI drill-through re-sorts client-side.
    useProgramProjects.mockReturnValue({
      data: [
        proj({ id: 'a', name: 'Alpha', overdueCount: 1, atRiskCount: 1 }),
        proj({ id: 'b', name: 'Bravo', overdueCount: 5, atRiskCount: 0 }),
        proj({ id: 'c', name: 'Charlie', overdueCount: 0, atRiskCount: 4 }),
      ],
      isLoading: false,
      error: null,
    });
  });

  function rowOrder(): string[] {
    return screen
      .getAllByRole('listitem')
      .map((li) => within(li).getByRole('link').textContent ?? '');
  }

  it('keeps server order with no sort param', () => {
    renderPage();
    expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('floats the highest at-risk projects first with ?sort=at-risk', () => {
    renderPage('/programs/prog-1/projects?sort=at-risk');
    expect(rowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('floats the highest overdue projects first with ?sort=overdue', () => {
    renderPage('/programs/prog-1/projects?sort=overdue');
    expect(rowOrder()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('ignores an unknown sort value', () => {
    renderPage('/programs/prog-1/projects?sort=bogus');
    expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('ProgramProjectsPage error state (#2176)', () => {
  beforeEach(() => {
    refetchProjects.mockReset();
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER } });
    useProgramProjects.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch: refetchProjects,
    });
  });

  it('renders the shared retryable error state on a failed projects fetch', async () => {
    renderPage();
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent(/Couldn't load this program's projects/i);
    await userEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });
});

describe('ProgramProjectsPage remove-from-program confirm (#2176)', () => {
  beforeEach(() => {
    removeMutateAsync.mockReset();
    removeMutateAsync.mockResolvedValue(undefined);
    // ADMIN role so the Remove affordance renders.
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 300 } });
    useProgramProjects.mockReturnValue({
      data: [proj({ id: 'a', name: 'Alpha' })],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
  });

  it('does not fire the unassign PATCH until the confirm dialog is accepted', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));

    // A confirm dialog appears naming the project and the consequence — the
    // PATCH has not fired yet.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Remove “Alpha” from “Riverside”/i);
    expect(dialog).toHaveTextContent(/shared backlog, rollup, and combined schedule/i);
    expect(removeMutateAsync).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: /Remove from program/i }));
    expect(removeMutateAsync).toHaveBeenCalledWith({ projectId: 'a', programId: null });
  });

  it('cancels without firing the PATCH', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeMutateAsync).not.toHaveBeenCalled();
  });

  it('names the program generically in the confirm when the program has no name yet', async () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', my_role: 300 } });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /Remove “Alpha” from this program\?/i,
    );
  });

  it('surfaces the server message when the unassign PATCH fails', async () => {
    removeMutateAsync.mockRejectedValue(new Error('Project is locked by another admin.'));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Remove from program/i }),
    );
    // The dialog closes and the failure is surfaced inline, not swallowed.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Project is locked by another admin.');
  });

  it('falls back to a generic message when the failure carries no message', async () => {
    removeMutateAsync.mockRejectedValue(new Error(''));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Remove from program/i }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to remove project.');
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    removeMutateAsync.mockRejectedValue('network down');
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Remove Alpha from this program/i }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Remove from program/i }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to remove project.');
  });
});

describe('ProgramProjectsPage route + role gating', () => {
  beforeEach(() => {
    useProgramProjects.mockReturnValue({
      data: [proj({ id: 'a', name: 'Alpha' })],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
  });

  it('renders nothing when the route carries no program id', () => {
    useProgram.mockReturnValue({ data: undefined });
    const { container } = renderWithoutProgramId();
    expect(container.firstChild).toBeNull();
  });

  it('withholds the admin toolbar while the program itself is still loading', () => {
    useProgram.mockReturnValue({ data: undefined });
    renderPage();
    expect(
      screen.queryByRole('toolbar', { name: 'Program projects actions' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Alpha/i })).not.toBeInTheDocument();
  });

  it('withholds the admin toolbar when the program carries no role for this user', () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside' } });
    renderPage();
    expect(
      screen.queryByRole('toolbar', { name: 'Program projects actions' }),
    ).not.toBeInTheDocument();
  });

  it('withholds the admin toolbar from a Scheduler (below ROLE_ADMIN)', () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 200 } });
    renderPage();
    expect(
      screen.queryByRole('toolbar', { name: 'Program projects actions' }),
    ).not.toBeInTheDocument();
  });

  it('shows the admin toolbar to an Owner', () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 400 } });
    renderPage();
    expect(screen.getByRole('toolbar', { name: 'Program projects actions' })).toBeInTheDocument();
  });
});

describe('ProgramProjectsPage loading state', () => {
  it('renders placeholder rows while the projects query is in flight', () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER } });
    useProgramProjects.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: refetchProjects,
    });
    renderPage();
    const skeleton = screen.getByLabelText('Loading projects');
    expect(skeleton.children).toHaveLength(3);
    // No count badge and no list until the data lands.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('ProgramProjectsPage empty state', () => {
  beforeEach(() => {
    useProgramProjects.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
  });

  function emptyPanel(): HTMLElement {
    return screen.getByText(/No projects in this program yet/i).closest('div') as HTMLElement;
  }

  it('offers all three creation routes to an admin', async () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 300 } });
    renderPage();
    const panel = emptyPanel();
    expect(within(panel).getByRole('button', { name: 'Add existing' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Import' })).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'New project modal' })).toBeInTheDocument();
  });

  it('opens the add-existing modal from the empty state', async () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 300 } });
    renderPage();
    await userEvent.click(within(emptyPanel()).getByRole('button', { name: 'Add existing' }));
    expect(screen.getByRole('dialog', { name: 'Add existing project modal' })).toBeInTheDocument();
  });

  it('opens the import modal from the empty state', async () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 300 } });
    renderPage();
    await userEvent.click(within(emptyPanel()).getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('dialog', { name: 'Import project modal' })).toBeInTheDocument();
  });

  it('offers a non-admin the explanation without any creation actions', () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER } });
    renderPage();
    expect(within(emptyPanel()).queryByRole('button')).not.toBeInTheDocument();
    // The count badge still renders — an empty list is a known-zero, not unknown.
    expect(screen.getByRole('heading', { name: /Projects/ })).toHaveTextContent('0');
  });
});

describe('ProgramProjectsPage creation modals (#797)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 300 } });
    useProgramProjects.mockReturnValue({
      data: [proj({ id: 'a', name: 'Alpha' })],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
  });

  function toolbar(): HTMLElement {
    return screen.getByRole('toolbar', { name: 'Program projects actions' });
  }

  it('opens the add-existing modal scoped to the program and closes it again', async () => {
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Add existing' }));
    const dialog = screen.getByRole('dialog', { name: 'Add existing project modal' });
    expect(dialog).toHaveTextContent('add-existing program: Riverside');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close add existing' }));
    expect(
      screen.queryByRole('dialog', { name: 'Add existing project modal' }),
    ).not.toBeInTheDocument();
  });

  it('passes an empty program name to the add-existing modal before the program loads its name', async () => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', my_role: 300 } });
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Add existing' }));
    expect(screen.getByRole('dialog', { name: 'Add existing project modal' })).toHaveTextContent(
      'add-existing program: (unnamed)',
    );
  });

  it('navigates to the new project once the new-project modal reports it created', async () => {
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project modal' });
    expect(dialog).toHaveTextContent('new-project program: Riverside');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finish new project' }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/created-1/overview');
    expect(screen.queryByRole('dialog', { name: 'New project modal' })).not.toBeInTheDocument();
  });

  it('closes the new-project modal without navigating on cancel', async () => {
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'New project' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close new project' }));
    expect(screen.queryByRole('dialog', { name: 'New project modal' })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to the imported project once the import modal reports it created', async () => {
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import project modal' });
    expect(dialog).toHaveTextContent('import program: Riverside');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finish import' }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/imported-1/overview');
    expect(screen.queryByRole('dialog', { name: 'Import project modal' })).not.toBeInTheDocument();
  });

  it('closes the import modal without navigating on cancel', async () => {
    renderPage();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Import' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close import' }));
    expect(screen.queryByRole('dialog', { name: 'Import project modal' })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('ProgramProjectsPage drill-through sort with missing counts (#2155)', () => {
  beforeEach(() => {
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: ROLE_VIEWER } });
  });

  function rowOrder(): string[] {
    return screen
      .getAllByRole('listitem')
      .map((li) => within(li).getByRole('link').textContent ?? '');
  }

  it('sorts projects whose counts have not been computed last', () => {
    useProgramProjects.mockReturnValue({
      data: [
        proj({ id: 'a', name: 'Alpha', overdueCount: null }),
        proj({ id: 'b', name: 'Bravo', overdueCount: 0 }),
        proj({ id: 'c', name: 'Charlie', overdueCount: 3 }),
      ],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
    renderPage('/programs/prog-1/projects?sort=overdue');
    // null is treated as -1 so an uncomputed project never outranks a real zero.
    expect(rowOrder()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it.each([
    ['trailing', [null, 4] as const, ['Bravo', 'Alpha']],
    ['leading', [4, null] as const, ['Alpha', 'Bravo']],
  ])('keeps an uncomputed at-risk count last (%s null)', (_label, counts, expected) => {
    useProgramProjects.mockReturnValue({
      data: [
        proj({ id: 'a', name: 'Alpha', atRiskCount: counts[0] }),
        proj({ id: 'b', name: 'Bravo', atRiskCount: counts[1] }),
      ],
      isLoading: false,
      error: null,
      refetch: refetchProjects,
    });
    renderPage('/programs/prog-1/projects?sort=at-risk');
    expect(rowOrder()).toEqual(expected);
  });

  it('leaves an undefined project list alone under a sort param', () => {
    useProgramProjects.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: refetchProjects,
    });
    renderPage('/programs/prog-1/projects?sort=at-risk');
    expect(screen.getByLabelText('Loading projects')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
