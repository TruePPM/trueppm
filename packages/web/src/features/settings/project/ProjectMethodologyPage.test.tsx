import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectMethodologyPage } from './ProjectMethodologyPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';

const useProjectId = vi.fn();
const useProject = vi.fn();
const useUpdateProject = vi.fn();
const useCurrentUserRole = vi.fn();
const useWorkspaceSettings = vi.fn();
const mutateAsync = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: (id: string | undefined) => useProject(id) as { data: unknown },
}));
vi.mock('@/hooks/useProjectMutations', () => ({
  useUpdateProject: (id: string | undefined) =>
    useUpdateProject(id) as { mutateAsync: (p: unknown) => Promise<unknown> },
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => useCurrentUserRole() as { role: number | null; isLoading: boolean },
}));
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings() as { data: unknown },
}));

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    inherited_methodology: 'WATERFALL',
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectMethodologyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectMethodologyPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    useProjectId.mockReturnValue('p-1');
    useUpdateProject.mockReturnValue({ mutateAsync });
    // Admin can edit; workspace allows overrides (SUGGEST).
    useCurrentUserRole.mockReturnValue({ role: 400, isLoading: false });
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'suggest' } });
    useProject.mockReturnValue({ data: makeProject() });
    useSettingsSaveStore.getState().reset();
  });

  it('seeds the picker from the project methodology and shows the inherited default', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /Agile/i, checked: true })).toBeInTheDocument();
    // The inherited (workspace/program) default is surfaced as context.
    expect(screen.getByText(/Inherited from the workspace default/i)).toBeInTheDocument();
  });

  it('saves the chosen override via PATCH for an Admin under SUGGEST', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: /Waterfall/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ methodology: 'WATERFALL' });
  });

  it('locks the picker and shows the workspace value under an INHERIT policy', () => {
    useWorkspaceSettings.mockReturnValue({ data: { methodologyOverridePolicy: 'inherit' } });
    useProject.mockReturnValue({
      data: makeProject({ methodology: 'AGILE', effective_methodology: 'WATERFALL' }),
    });
    renderPage();

    expect(screen.getByText(/requires every project to use its default methodology/i)).toBeInTheDocument();
    // Locked: shows the workspace-resolved value (WATERFALL), not the project's own AGILE.
    expect(screen.getByRole('radio', { name: /Waterfall/i, checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Waterfall/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Agile/i, checked: false })).toBeInTheDocument();
  });

  it('renders read-only for a sub-Admin role', () => {
    useCurrentUserRole.mockReturnValue({ role: 100, isLoading: false });
    renderPage();
    expect(screen.getByRole('radio', { name: /Agile/i })).toBeDisabled();
  });
});
