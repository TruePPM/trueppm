import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '@/test/utils';
import { ProjectListItem } from './ProjectListItem';
import type { Project } from '@/types';

/**
 * Renders ProjectListItem under a route with a real :projectId param so that
 * useParams() returns the projectId and exercises the truthy branch of viewSuffix.
 */
function renderWithProjectRoute(
  project: Project,
  collapsed: boolean,
  url: string,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/projects/:projectId/*', element: <ProjectListItem project={project} collapsed={collapsed} /> }],
    { initialEntries: [url] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Alpha Platform',
  colorDot: '#1C6B3A',
  healthState: 'on-track',
  methodology: 'HYBRID',
  programId: null,
};

const PROJECT_AT_RISK: Project = {
  id: 'proj-2',
  name: 'Beta Migration',
  colorDot: '#E8A020',
  healthState: 'at-risk',
  methodology: 'HYBRID',
  programId: null,
};

const PROJECT_CRITICAL: Project = {
  id: 'proj-3',
  name: 'Gamma Compliance',
  colorDot: '#B91C1C',
  healthState: 'critical',
  methodology: 'HYBRID',
  programId: null,
};

const PROJECT_UNKNOWN: Project = {
  id: 'proj-4',
  name: 'Delta Infrastructure',
  colorDot: '#6B6965',
  healthState: 'unknown',
  methodology: 'HYBRID',
  programId: null,
};

describe('ProjectListItem — expanded (collapsed=false)', () => {
  it('renders project name and health label when expanded', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />);
    expect(screen.getByText('Alpha Platform')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
  });

  it('renders at-risk health label', () => {
    renderWithRouter(<ProjectListItem project={PROJECT_AT_RISK} collapsed={false} />);
    expect(screen.getByText('At risk')).toBeInTheDocument();
  });

  it('renders critical health label', () => {
    renderWithRouter(<ProjectListItem project={PROJECT_CRITICAL} collapsed={false} />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('renders unknown health label', () => {
    renderWithRouter(<ProjectListItem project={PROJECT_UNKNOWN} collapsed={false} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('does not set aria-label when not collapsed', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />);
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('aria-label');
  });

  it('does not set title when not collapsed', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />);
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('title');
  });
});

describe('ProjectListItem — collapsed (collapsed=true)', () => {
  it('does not render project name text in collapsed mode', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed />);
    // Name text is not visible when collapsed
    expect(screen.queryByText('Alpha Platform')).not.toBeInTheDocument();
  });

  it('sets aria-label with name and health when collapsed', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'Alpha Platform — On track');
  });

  it('sets title to project name when collapsed', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('title', 'Alpha Platform');
  });
});

describe('ProjectListItem — active project', () => {
  it('marks the link with aria-current="page" when it is the active project', () => {
    // Render under a URL that matches the project ID
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />, {
      initialEntries: ['/projects/proj-1/board'],
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark aria-current for non-active projects', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />, {
      initialEntries: ['/projects/proj-99/board'],
    });
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('falls back to /board when not in a project route (no projectId param)', () => {
    // The renderWithRouter uses a * route so useParams returns no projectId.
    // In that case viewSuffix falls back to '/board'.
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />, {
      initialEntries: ['/some-other-page'],
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/projects/proj-1/board');
  });

  it('generates a link with /board suffix by default', () => {
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />, {
      initialEntries: ['/'],
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/projects/proj-1/board');
  });

  it('renders the projects link with /board suffix when not inside any project route', () => {
    // When there is no currentProjectId (not inside a project route), viewSuffix defaults to /board
    renderWithRouter(<ProjectListItem project={PROJECT} collapsed={false} />, {
      initialEntries: ['/dashboard'],
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/projects/proj-1/board');
  });
});

describe('ProjectListItem — inside a project route (useParams returns projectId)', () => {
  it('preserves /schedule suffix when viewing the schedule tab of the same project', () => {
    // Renders under /projects/proj-1/schedule — currentProjectId === 'proj-1'
    // viewSuffix extracts '/schedule' from the path
    renderWithProjectRoute(PROJECT, false, '/projects/proj-1/schedule');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/projects/proj-1/schedule');
  });

  it('marks aria-current="page" for the active project inside a project route', () => {
    renderWithProjectRoute(PROJECT, false, '/projects/proj-1/board');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not set aria-current for a different project inside a project route', () => {
    // currentProjectId is 'proj-1' but this component renders PROJECT_AT_RISK (id: 'proj-2')
    renderWithProjectRoute(PROJECT_AT_RISK, false, '/projects/proj-1/board');
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('falls back to /board when the path suffix is empty (root project route)', () => {
    // URL is /projects/proj-1 — replace leaves an empty string → falls back to /board
    renderWithProjectRoute(PROJECT, false, '/projects/proj-1');
    const link = screen.getByRole('link');
    // viewSuffix: pathname.replace('/projects/proj-1', '') === '' → '/board'
    expect(link).toHaveAttribute('href', '/projects/proj-1/board');
  });

  it('sets aria-label with name and health when collapsed inside a project route', () => {
    renderWithProjectRoute(PROJECT, true, '/projects/proj-1/board');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', 'Alpha Platform — On track');
  });
});
