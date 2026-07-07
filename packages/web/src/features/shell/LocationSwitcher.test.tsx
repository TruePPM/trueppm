import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { LocationSwitcher } from './LocationSwitcher';
import type { LocationModel } from './useLocationModel';

vi.mock('./useLocationModel', () => ({ useLocationModel: vi.fn() }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: vi.fn(() => 'lg') }));
vi.mock('@/features/programs/ProgramIdentitySquare', () => ({
  ProgramIdentitySquare: () => <span data-testid="identity-square" aria-hidden="true" />,
}));
// The segment's listbox internals are covered by LocationSegment.test; stub it to a
// button carrying the noun + current name so composition assertions stay structural.
vi.mock('./LocationSegment', () => ({
  LocationSegment: ({
    noun,
    currentName,
    currentSubtitle,
  }: {
    noun: string;
    currentName?: string;
    currentSubtitle?: string;
  }) => (
    <button type="button" aria-label={`Current ${noun}: ${currentName}. Switch ${noun}.`}>
      {currentName}
      {currentSubtitle && <span data-testid={`${noun}-subtitle`}>{currentSubtitle}</span>}
    </button>
  ),
}));

import { useLocationModel } from './useLocationModel';
import { useBreakpoint } from '@/hooks/useBreakpoint';

const mockModel = useLocationModel as ReturnType<typeof vi.fn>;
const mockBreakpoint = useBreakpoint as ReturnType<typeof vi.fn>;

// A minimal Program stand-in — the real ProgramIdentitySquare is mocked, so only
// the shape matters to the type checker, not the full field set.
const PROGRAM = {
  id: 'prog-1',
  name: 'Apollo',
  color: '#3E8C6D',
  code: 'APL',
} as unknown as NonNullable<LocationModel['program']>['current'];

function model(overrides: Partial<LocationModel> = {}): LocationModel {
  return {
    suppressed: false,
    program: {
      options: [
        { id: 'prog-1', name: 'Apollo', to: '/programs/prog-1/overview' },
        { id: 'prog-2', name: 'Gemini', to: '/programs/prog-2/overview' },
      ],
      current: PROGRAM,
    },
    project: {
      options: [
        { id: 'p1', name: 'Launch Site', to: '/projects/p1/board' },
        { id: 'p2', name: 'Rover', to: '/projects/p2/board' },
      ],
      currentId: 'p1',
      currentName: 'Launch Site',
      currentMethodologyLabel: 'Hybrid',
    },
    leaf: 'Board',
    ...overrides,
  };
}

describe('LocationSwitcher (#1643)', () => {
  beforeEach(() => {
    mockModel.mockReset();
    mockBreakpoint.mockReturnValue('lg');
  });

  it('renders nothing on a suppressed (settings) route', () => {
    mockModel.mockReturnValue(model({ suppressed: true }));
    const { container } = renderWithRouter(<LocationSwitcher />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders Program › Project › Leaf on a project route with a program', () => {
    mockModel.mockReturnValue(model());
    renderWithRouter(<LocationSwitcher />);
    expect(screen.getByRole('button', { name: /Current program: Apollo/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Current project: Launch Site/ }),
    ).toBeInTheDocument();
    // The leaf is a plain aria-current label, never a dropdown.
    const leaf = screen.getByText('Board');
    expect(leaf).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument();
  });

  it('omits the program segment on a project with no program', () => {
    mockModel.mockReturnValue(model({ program: null }));
    renderWithRouter(<LocationSwitcher />);
    expect(screen.queryByRole('button', { name: /Current program/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Current project/ })).toBeInTheDocument();
  });

  it('omits the project segment on a program route', () => {
    mockModel.mockReturnValue(model({ project: null, leaf: 'Overview' }));
    renderWithRouter(<LocationSwitcher />);
    expect(screen.getByRole('button', { name: /Current program/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Current project/ })).not.toBeInTheDocument();
    expect(screen.getByText('Overview')).toHaveAttribute('aria-current', 'page');
  });

  it('collapses to a leaf-only label off a project/program (global route)', () => {
    mockModel.mockReturnValue(model({ program: null, project: null, leaf: 'My Work' }));
    renderWithRouter(<LocationSwitcher />);
    expect(
      screen.queryByRole('button', { name: /Current (program|project)/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('My Work')).toHaveAttribute('aria-current', 'page');
  });

  it('passes the methodology label as the project picker subtitle only, not the program (#1680)', () => {
    mockModel.mockReturnValue(model());
    renderWithRouter(<LocationSwitcher />);
    expect(screen.getByTestId('project-subtitle')).toHaveTextContent('Hybrid');
    // The program segment never receives a methodology subtitle.
    expect(screen.queryByTestId('program-subtitle')).not.toBeInTheDocument();
  });

  it('mobile renders non-interactive wayfinding (Project › Leaf, no pickers)', () => {
    mockBreakpoint.mockReturnValue('sm');
    mockModel.mockReturnValue(model());
    renderWithRouter(<LocationSwitcher />);
    // No picker buttons on mobile — switching happens through the rail drawer.
    expect(screen.queryByRole('button', { name: /Switch/ })).not.toBeInTheDocument();
    expect(screen.getByText('Launch Site')).toBeInTheDocument();
    expect(screen.getByText('Board')).toHaveAttribute('aria-current', 'page');
  });
});
