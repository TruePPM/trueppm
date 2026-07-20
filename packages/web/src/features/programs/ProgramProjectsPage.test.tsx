import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgramProjectsPage } from './ProgramProjectsPage';
import type { Project } from '@/types';

const useProgram = vi.fn();
const useProgramProjects = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: unknown },
}));
vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () =>
    useProgramProjects() as { data: Project[] | undefined; isLoading: boolean; error: unknown },
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useAssignProjectToProgram: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
