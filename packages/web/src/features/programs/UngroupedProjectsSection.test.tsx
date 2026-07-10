import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UngroupedProject } from '@/hooks/useUngroupedProjects';
import { UngroupedProjectsSection } from './UngroupedProjectsSection';

const useUngroupedProjects = vi.fn();

vi.mock('@/hooks/useUngroupedProjects', () => ({
  useUngroupedProjects: () =>
    useUngroupedProjects() as { data: unknown; isLoading: boolean; error: Error | null },
}));

// MoveToProgramModal dependencies — the section mounts the modal on "Move".
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/hooks/useProgramMutations', () => ({
  useAssignProjectToProgram: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function makeProject(overrides: Partial<UngroupedProject> = {}): UngroupedProject {
  return {
    id: 'pr-1',
    name: 'Neptune Cryo Rig',
    code: 'NEP',
    healthState: 'on-track',
    percentComplete: 38,
    memberCount: 4,
    ...overrides,
  };
}

describe('UngroupedProjectsSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['loading', { data: undefined, isLoading: true, error: null }],
    ['error', { data: undefined, isLoading: false, error: new Error('x') }],
    ['empty', { data: [], isLoading: false, error: null }],
  ])('renders nothing when %s', (_label, state) => {
    useUngroupedProjects.mockReturnValue(state);
    const { container } = render(<UngroupedProjectsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a header, count pill, and one row per standalone project', () => {
    useUngroupedProjects.mockReturnValue({
      data: [
        makeProject({ id: 'a', name: 'Neptune Cryo Rig', code: 'NEP', percentComplete: 38, memberCount: 4 }),
        makeProject({ id: 'b', name: 'Cedar Heights', code: 'CED', percentComplete: 88, memberCount: 2 }),
      ],
      isLoading: false,
      error: null,
    });
    render(<UngroupedProjectsSection />);

    expect(screen.getByRole('heading', { name: /Ungrouped projects/i })).toBeInTheDocument();
    expect(screen.getByText('2 need a home')).toBeInTheDocument();
    expect(screen.getByText('Neptune Cryo Rig')).toBeInTheDocument();
    expect(screen.getByText('NEP')).toBeInTheDocument();
    // Values are visibly self-describing — the unit is in the copy, not aria-only.
    expect(screen.getByText('38% complete')).toBeInTheDocument();
    expect(screen.getByText('4 members')).toBeInTheDocument();
    // Health conveyed as text, not color alone (rule 6).
    expect(screen.getAllByText(/On track\./).length).toBeGreaterThan(0);
  });

  it('labels unknown aggregates and uses singular "member"', () => {
    useUngroupedProjects.mockReturnValue({
      data: [makeProject({ percentComplete: null, memberCount: 1 })],
      isLoading: false,
      error: null,
    });
    render(<UngroupedProjectsSection />);
    expect(screen.getByText('Progress unknown')).toBeInTheDocument();
    expect(screen.getByText('1 member')).toBeInTheDocument();
  });

  it('opens the move-to-program dialog from a row', async () => {
    useUngroupedProjects.mockReturnValue({
      data: [makeProject({ name: 'Neptune Cryo Rig' })],
      isLoading: false,
      error: null,
    });
    render(<UngroupedProjectsSection />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Move to program/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Move .*Neptune Cryo Rig.* to a program/);
  });
});
