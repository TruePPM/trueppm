import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AddProjectToProgramModal } from './AddProjectToProgramModal';
import type { Methodology, Project } from '@/types';

const useProjects = vi.fn();
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => useProjects() as { data: Project[] | undefined; isLoading: boolean },
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useAssignProjectToProgram: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function project(name: string, methodology: Methodology, programId: string | null): Project {
  return {
    id: `proj-${name}`,
    name,
    colorDot: '#6B6965',
    healthState: 'unknown',
    openTaskCount: null,
    methodology,
    programId,
  };
}

function renderModal() {
  return render(
    <AddProjectToProgramModal programId="prog-1" programName="Riverside" onClose={() => {}} />,
  );
}

describe('AddProjectToProgramModal methodology chips + filter (#564)', () => {
  beforeEach(() => {
    useProjects.mockReturnValue({
      data: [
        project('Waterfall One', 'WATERFALL', null),
        project('Agile Two', 'AGILE', null),
        project('Hybrid Three', 'HYBRID', 'prog-other'),
        // already in THIS program → excluded as a no-op move
        project('Already Here', 'AGILE', 'prog-1'),
      ],
      isLoading: false,
    });
  });

  it('renders a methodology badge on each candidate row', () => {
    renderModal();
    expect(screen.getByText('Waterfall One')).toBeInTheDocument();
    // Title-case labels, not the shouty enum.
    expect(screen.getAllByText('Waterfall').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agile').length).toBeGreaterThan(0);
    // The project already in this program is filtered out.
    expect(screen.queryByText('Already Here')).not.toBeInTheDocument();
  });

  it('narrows the visible rows by methodology when a filter chip is activated', () => {
    renderModal();
    expect(screen.getByText('Waterfall One')).toBeInTheDocument();
    expect(screen.getByText('Agile Two')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));

    expect(screen.queryByText('Waterfall One')).not.toBeInTheDocument();
    expect(screen.getByText('Agile Two')).toBeInTheDocument();
    expect(screen.queryByText('Hybrid Three')).not.toBeInTheDocument();
  });

  it('narrows by search and methodology together', () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText('Search projects'), {
      target: { value: 'one' },
    });
    expect(screen.getByText('Waterfall One')).toBeInTheDocument();
    expect(screen.queryByText('Agile Two')).not.toBeInTheDocument();
  });

  it('shows a "no matches" status when the active filter hides every candidate', () => {
    useProjects.mockReturnValue({
      data: [project('Only Waterfall', 'WATERFALL', null)],
      isLoading: false,
    });
    renderModal();
    fireEvent.click(screen.getByRole('radio', { name: 'Agile' }));
    expect(screen.getByRole('status')).toHaveTextContent(/No projects match/i);
  });

  it('groups standalone vs in-another-program candidates', () => {
    renderModal();
    const standalone = screen.getByRole('heading', { name: /Standalone projects/i });
    expect(standalone).toBeInTheDocument();
    expect(within(standalone.parentElement as HTMLElement).getByText('Waterfall One')).toBeTruthy();
  });
});
