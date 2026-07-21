import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramProjectsPage } from './ProgramProjectsPage';
import type { Project } from '@/types';

const useProgram = vi.fn();
const useProgramProjects = vi.fn();
const refetchProjects = vi.fn();
const removeMutateAsync = vi.fn<(args: { projectId: string; programId: string | null }) => Promise<unknown>>();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
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
// The three creation modals are never opened in these tests; stub them so their
// module trees don't drag heavy deps into the unit test.
vi.mock('@/features/shell/NewProjectModal', () => ({ NewProjectModal: () => null }));
vi.mock('@/components/import/ImportProjectModal', () => ({ ImportProjectModal: () => null }));
vi.mock('./AddProjectToProgramModal', () => ({ AddProjectToProgramModal: () => null }));

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
      data: { id: 'prog-1', name: 'Riverside', my_role: 0, target_date: '2026-09-30' },
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
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 0, target_date: null } });
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
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 0 } });
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
    useProgram.mockReturnValue({ data: { id: 'prog-1', name: 'Riverside', my_role: 0 } });
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
});
