import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Program } from '@/api/types';
import { ProgramShell } from './ProgramShell';

const useProgram = vi.fn();

vi.mock('@/hooks/useProgram', () => ({
  useProgram: () => useProgram() as { data: Program | undefined; isLoading: boolean; error: unknown },
}));

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    name: 'Apollo',
    description: 'Lunar program',
    methodology: 'HYBRID',
    my_role: 4,
    my_role_label: 'Program Owner',
    ...overrides,
  } as Program;
}

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/programs/:programId" element={<ProgramShell />}>
          <Route path="overview" element={<div>OVERVIEW_OUTLET</div>} />
          <Route path="settings/general" element={<div>SETTINGS_OUTLET</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('<ProgramShell>', () => {
  beforeEach(() => {
    useProgram.mockReset();
    useProgram.mockReturnValue({ data: makeProgram(), isLoading: false, error: null });
  });

  it('renders the program header and tab strip on a working (non-settings) route', () => {
    renderShell('/programs/p-1/overview');
    expect(screen.getByRole('navigation', { name: 'Program sections' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Apollo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByText('OVERVIEW_OUTLET')).toBeInTheDocument();
  });

  // #776: settings is a focused mode — the program header + tab strip are suppressed
  // so the shared SettingsShell mounts top-aligned, identical to the workspace and
  // project scopes. Without this the SCOPE switcher jumped ~100px when switching scope.
  it('suppresses the program header and tab strip on a settings route', () => {
    renderShell('/programs/p-1/settings/general');
    expect(screen.queryByRole('navigation', { name: 'Program sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Apollo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backlog' })).not.toBeInTheDocument();
    // The settings outlet still renders — only the program chrome is gone.
    expect(screen.getByText('SETTINGS_OUTLET')).toBeInTheDocument();
  });
});
