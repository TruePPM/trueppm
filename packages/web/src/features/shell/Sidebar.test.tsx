import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { useShellStore } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { Sidebar } from './Sidebar';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      { id: 'p1', name: 'Alpha Platform', programId: 'prog1', healthState: 'unknown', colorDot: '#3E8C6D' },
      { id: 'p2', name: 'Beta Migration', programId: 'prog1', healthState: 'unknown', colorDot: '#E8A020' },
      { id: 'p3', name: 'Standalone Site', programId: null, healthState: 'unknown', colorDot: '#B91C1C' },
    ],
  }),
}));
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({ data: [{ id: 'prog1', name: 'Artemis', code: 'ART' }] }),
}));
vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: () => ({ data: { pages: [{ due_today_count: 3 }] } }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { initials: 'AK', display_name: 'Anika K.', can_access_admin_settings: true },
  }),
}));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ edition: 'community' }) }));
vi.mock('./NewProjectModal', () => ({ NewProjectModal: () => null }));
vi.mock('@/features/programs/NewProgramModal', () => ({ NewProgramModal: () => null }));
vi.mock('@/components/import/ImportProjectModal', () => ({ ImportProjectModal: () => null }));

function renderRail(props = {}) {
  return render(
    <MemoryRouter>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useShellStore.setState({
    sidebarCollapsed: false,
    sidebarUserControlled: false,
    pinnedProjectIds: [],
    expandedProgramIds: [],
  });
  useCommandPaletteStore.setState({ open: false });
});

describe('Sidebar (v2 left rail)', () => {
  it('renders the brand, ⌘K trigger, and the Personal group', () => {
    renderRail();
    expect(screen.getByText('True')).toBeInTheDocument();
    expect(screen.getByText('PPM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search or jump to/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My Work, 3 due today/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('opens the command palette from the rail ⌘K trigger', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/i }));
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('expands a program to reveal its projects', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: /Alpha Platform/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    expect(screen.getByRole('button', { name: /Alpha Platform, health unknown/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta Migration, health unknown/ })).toBeInTheDocument();
  });

  it('pins a project into the Shortcuts group', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    // Before pinning: Alpha appears once (in the program tree).
    expect(screen.getAllByRole('button', { name: /Alpha Platform, health unknown/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Pin Alpha Platform to Shortcuts/ }));
    expect(useShellStore.getState().pinnedProjectIds).toContain('p1');
    expect(screen.getByText('Shortcuts')).toBeInTheDocument();
    // After pinning: it appears twice (Shortcuts + the tree).
    expect(screen.getAllByRole('button', { name: /Alpha Platform, health unknown/ })).toHaveLength(2);
  });

  it('shows standalone (no-program) projects under Projects', () => {
    renderRail();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Standalone Site, health unknown/ }),
    ).toBeInTheDocument();
  });

  it('toggles collapse', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Collapse sidebar/i }));
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
  });

  it('calls onClose on Escape in drawer mode', () => {
    const onClose = vi.fn();
    renderRail({ isDrawer: true, onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the Organization group in the community edition', () => {
    renderRail();
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio rollup')).not.toBeInTheDocument();
  });
});
