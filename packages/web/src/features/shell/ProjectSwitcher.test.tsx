import { screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import type { Project } from '@/types';
import { ProjectSwitcher } from './ProjectSwitcher';

const mockNavigate = vi.fn();

// Keep useLocation / useMatch / useParams real (drives the self-gate + view
// derivation); mock only useNavigate so a switch is observable.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => 'proj-1') }));
vi.mock('@/hooks/useProjects', () => ({ useProjects: vi.fn() }));

import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';

const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProjects = useProjects as ReturnType<typeof vi.fn>;

function project(id: string, name: string): Project {
  return {
    id,
    name,
    colorDot: '#3E8C6D',
    healthState: 'unknown',
    openTaskCount: null,
    methodology: 'HYBRID',
    programId: null,
  };
}

const THREE = [
  project('proj-1', 'Alpha Platform'),
  project('proj-2', 'Beta Migration'),
  project('proj-3', 'Gamma Rollout'),
];

function open() {
  fireEvent.click(screen.getByRole('button', { name: /Switch project/i }));
}

describe('ProjectSwitcher (#1478)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProjects.mockReturnValue({ data: THREE, isLoading: false, error: null });
  });

  it('renders nothing off a project route', () => {
    mockUseProjectId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/me/work'] });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on a project settings route', () => {
    const { container } = renderWithRouter(<ProjectSwitcher />, {
      initialEntries: ['/projects/proj-1/settings/cadence'],
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the user is a member of fewer than two projects', () => {
    mockUseProjects.mockReturnValue({
      data: [project('proj-1', 'Alpha Platform')],
      isLoading: false,
      error: null,
    });
    const { container } = renderWithRouter(<ProjectSwitcher />, {
      initialEntries: ['/projects/proj-1/schedule'],
    });
    expect(container.firstChild).toBeNull();
  });

  it('opens a searchable listbox of the member projects', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    const listbox = screen.getByRole('listbox', { name: 'Switch project' });
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Alpha Platform', 'Beta Migration', 'Gamma Rollout']),
    );
    // The current project is marked selected.
    expect(within(listbox).getByRole('option', { name: /Alpha Platform/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('filters the list by case-insensitive substring on name', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project' }), {
      target: { value: 'beta' },
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Beta Migration');
  });

  it('shows a status row when no project matches the query', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project' }), {
      target: { value: 'zzz' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No projects match');
  });

  it('selecting another project navigates to the same view on that project', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    fireEvent.click(screen.getByRole('option', { name: /Beta Migration/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-2/schedule');
  });

  it('preserves the active view segment across the switch (board → board)', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    fireEvent.click(screen.getByRole('option', { name: /Gamma Rollout/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-3/board');
  });

  it('selecting the current project is a no-op (closes without navigating)', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    fireEvent.click(screen.getByRole('option', { name: /Alpha Platform/ }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('supports keyboard selection (ArrowDown then Enter)', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    const input = screen.getByRole('combobox', { name: 'Find a project' });
    // Highlight starts on the current project (proj-1, index 0); ArrowDown → proj-2.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-2/schedule');
  });

  it('Escape is two-stage: clears a query first, then closes', () => {
    renderWithRouter(<ProjectSwitcher />, { initialEntries: ['/projects/proj-1/schedule'] });
    open();
    const input = screen.getByRole('combobox', { name: 'Find a project' });
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // First Escape clears the query but keeps the list open (all projects back).
    expect(screen.getByRole('combobox', { name: 'Find a project' })).toHaveValue('');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // Second Escape closes.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Find a project' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
