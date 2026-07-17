import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { ResourceAssignmentsSection } from './ResourceAssignmentsSection';
import type { ResourceAssignment } from '@/hooks/useResourceAssignments';

interface MockUser {
  user?: { can_access_admin_settings?: boolean };
}
interface MockQuery {
  data?: ResourceAssignment[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

const mockUseCurrentUser = vi.fn<() => MockUser>();
const mockUseResourceAssignments = vi.fn<() => MockQuery>();

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}));
vi.mock('@/hooks/useResourceAssignments', () => ({
  useResourceAssignments: () => mockUseResourceAssignments(),
}));

function query(over: Partial<MockQuery>): MockQuery {
  return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...over };
}

function rows(over: Partial<ResourceAssignment>[]): ResourceAssignment[] {
  return over.map((o, i) => ({
    id: String(i),
    taskId: `t${i}`,
    taskName: 'Task',
    projectId: 'p',
    projectName: 'Proj',
    status: 'NOT_STARTED',
    percentComplete: 0,
    units: 1,
    ...o,
  }));
}

beforeEach(() => {
  mockUseCurrentUser.mockReset();
  mockUseResourceAssignments.mockReset();
  mockUseResourceAssignments.mockReturnValue(query({ data: [] }));
});

describe('ResourceAssignmentsSection (#2047)', () => {
  it('renders nothing for a non-admin (section hidden, no request)', () => {
    mockUseCurrentUser.mockReturnValue({ user: { can_access_admin_settings: false } });
    const { container } = renderWithProvidersAndRouter(
      <ResourceAssignmentsSection resourceId="r1" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockUseResourceAssignments).not.toHaveBeenCalled();
  });

  it('shows grouped assignments with a cross-project count for an admin', () => {
    mockUseCurrentUser.mockReturnValue({ user: { can_access_admin_settings: true } });
    mockUseResourceAssignments.mockReturnValue(
      query({
        data: rows([
          { projectId: 'p1', projectName: 'Alpha', taskName: 'Design', percentComplete: 40 },
          { projectId: 'p2', projectName: 'Bravo', taskName: 'Build', status: 'COMPLETE' },
        ]),
      }),
    );
    renderWithProvidersAndRouter(<ResourceAssignmentsSection resourceId="r1" />);

    expect(screen.getByText('Assignments')).toBeInTheDocument();
    expect(screen.getByText('2 tasks across 2 projects')).toBeInTheDocument();
    // Row link carries a composite accessible name (project + status + percent + units).
    expect(
      screen.getByRole('link', {
        name: 'Design, Alpha, Not started, 40% complete, 1 allocation units',
      }),
    ).toHaveAttribute('href', '/projects/p1/schedule?task=t0');
    // Project header links to the per-project allocation view (its aria-label
    // spells out the navigation; the "(1)" count span is aria-hidden).
    expect(
      screen.getByRole('link', { name: 'Alpha — open allocation view' }),
    ).toHaveAttribute('href', '/projects/p1/resources/allocation');
  });

  it('shows an empty state for an admin with no assignments', () => {
    mockUseCurrentUser.mockReturnValue({ user: { can_access_admin_settings: true } });
    mockUseResourceAssignments.mockReturnValue(query({ data: [] }));
    renderWithProvidersAndRouter(<ResourceAssignmentsSection resourceId="r1" />);
    expect(screen.getByText('No current assignments.')).toBeInTheDocument();
  });

  it('renders nothing on a 403 (server gate is authoritative)', () => {
    mockUseCurrentUser.mockReturnValue({ user: { can_access_admin_settings: true } });
    mockUseResourceAssignments.mockReturnValue(
      query({
        isError: true,
        error: { isAxiosError: true, response: { status: 403 } },
      }),
    );
    const { container } = renderWithProvidersAndRouter(
      <ResourceAssignmentsSection resourceId="r1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an inline error + retry on a non-403 failure', () => {
    mockUseCurrentUser.mockReturnValue({ user: { can_access_admin_settings: true } });
    mockUseResourceAssignments.mockReturnValue(
      query({ isError: true, error: { isAxiosError: true, response: { status: 500 } } }),
    );
    renderWithProvidersAndRouter(<ResourceAssignmentsSection resourceId="r1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn.t load assignments/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
