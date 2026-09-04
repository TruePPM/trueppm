import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectVisibilityPage } from './ProjectVisibilityPage';

/**
 * Project > Surface visibility (ADR-0193, #956), with the #3376 correction.
 *
 * The load-bearing case is Time tracking: three of the four surfaces have a
 * reader and it has none, so it alone renders inert with a bound note while its
 * siblings stay editable. That asymmetry is the thing worth pinning — a spec
 * that only checked "four rows render" would pass on the version that offered a
 * Time tracking toggle whose save changed nothing.
 */

const useProjectId = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useCurrentUserRole = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: (projectId: string | undefined) => useProject(projectId) as { data: unknown },
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: (projectId: string | undefined) =>
    useUpdateProject(projectId) as { mutateAsync: (payload: unknown) => Promise<unknown> },
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));

const SEED_PROJECT = {
  id: 'p-1',
  server_version: 1,
  name: 'Atlas Migration',
  methodology: 'WATERFALL',
  effective_methodology: 'WATERFALL',
  show_reporting: null,
  show_time_tracking: null,
  show_baselines: null,
  show_monte_carlo: null,
  effective_surface_visibility: {
    reporting: true,
    time_tracking: true,
    baselines: true,
    monte_carlo: true,
  },
  inherited_surface_visibility: {
    reporting: true,
    time_tracking: true,
    baselines: true,
    monte_carlo: true,
  },
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/surfaces']}>
        <Routes>
          <Route path="/projects/:projectId/settings/surfaces" element={<ProjectVisibilityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
  useProject.mockReturnValue({ data: SEED_PROJECT });
  useUpdateProject.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined) });
  useCurrentUserRole.mockReturnValue({ role: 300, isLoading: false }); // Admin
});

describe('ProjectVisibilityPage', () => {
  it('renders all four surfaces', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: 'Surface visibility', exact: true }),
    ).toBeInTheDocument();
    for (const label of ['Reports', 'Time tracking', 'Baselines', 'Monte-Carlo forecast']) {
      expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
    }
  });

  it('leaves the three wired surfaces editable for an Admin', () => {
    renderPage();
    // Exactly three radiogroups: one per surface that has a reader. A fourth
    // would mean Time tracking got its toggle back.
    expect(screen.getAllByRole('radiogroup')).toHaveLength(3);
    for (const name of [
      'Show the Reports surface',
      'Show the Baselines surface',
      'Show the Monte-Carlo forecast surface',
    ]) {
      expect(screen.getByRole('radiogroup', { name })).toBeInTheDocument();
    }
  });

  it('renders Time tracking inert with a bound not-enforced note (#3376)', () => {
    renderPage();
    // No editable control for the surface nothing reads — not even for an Admin,
    // whose edit would be exactly as inert as a Viewer's.
    expect(
      screen.queryByRole('radiogroup', { name: 'Show the Time tracking surface' }),
    ).not.toBeInTheDocument();

    const group = screen.getByRole('group', { name: /^Show the Time tracking surface:/ });
    expect(group.getAttribute('aria-label')).toMatch(/Not enforced\.$/);
    // Never "View only." — that name promises the setting is enforced for
    // somebody with more rights, which is the assurance being withdrawn.
    expect(group.getAttribute('aria-label')).not.toMatch(/View only/);

    const noteId = group.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(noteId)).toHaveTextContent(/no surface reads this setting/i);
  });

  it('says in the row hint that Time tracking is stored but unread', () => {
    renderPage();
    // The hint is what a scanning admin reads before the ⓘ. It must not repeat
    // the old "hides the time-logging chrome (currently mobile)" claim — mobile
    // has never referenced any show_* field.
    expect(screen.getByText(/nothing reads it/i)).toBeInTheDocument();
    expect(screen.queryByText(/hides the time-logging chrome/i)).not.toBeInTheDocument();
  });

  it('shows read-only indicators for a Member and still suppresses Time tracking', () => {
    useCurrentUserRole.mockReturnValue({ role: 200, isLoading: false }); // Member
    renderPage();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    // The wired surfaces fall back to the ADR-0133 read-only indicator …
    expect(
      screen.getByLabelText('Show the Reports surface: On, inherited from the methodology default. View only.'),
    ).toBeInTheDocument();
    // … while Time tracking keeps the honest note, because "View only" would
    // still imply somebody, somewhere, is governed by the value.
    const group = screen.getByRole('group', { name: /^Show the Time tracking surface:/ });
    expect(within(group).getByText(/no surface reads this setting/i)).toBeInTheDocument();
  });
});
