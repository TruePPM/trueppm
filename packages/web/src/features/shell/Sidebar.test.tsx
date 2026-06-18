import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { useShellStore } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { Sidebar } from './Sidebar';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      // Real, server-mapped health + open-task count (#960) — the dot colors and
      // the count badge render from data, not a hardcoded 'unknown'.
      { id: 'p1', name: 'Alpha Platform', programId: 'prog1', healthState: 'at-risk', openTaskCount: 7, colorDot: '#3E8C6D' },
      { id: 'p2', name: 'Beta Migration', programId: 'prog1', healthState: 'on-track', openTaskCount: 0, colorDot: '#E8A020' },
      { id: 'p3', name: 'Standalone Site', programId: null, healthState: 'unknown', openTaskCount: 4, colorDot: '#B91C1C' },
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
    // Health maps from server data ('at risk', 'on track'), not a hardcoded
    // 'unknown' — and the open-task count rides in the accessible name (rule 6).
    expect(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta Migration, on track/ })).toBeInTheDocument();
  });

  it('colors each row health dot from server data and renders the open-task count badge (#960)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    // The right-aligned mono count renders for projects with open tasks (7, 4)
    // and is suppressed at zero (Beta Migration, on track).
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Health words are carried in each row's accessible name, mapped from data.
    expect(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Standalone Site, health unknown, 4 open tasks/ })).toBeInTheDocument();
  });

  it('pins a project into the Shortcuts group', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    // Before pinning: Alpha appears once (in the program tree).
    expect(screen.getAllByRole('button', { name: /Alpha Platform, at risk/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Pin Alpha Platform to Shortcuts/ }));
    expect(useShellStore.getState().pinnedProjectIds).toContain('p1');
    expect(screen.getByText('Shortcuts')).toBeInTheDocument();
    // After pinning: it appears twice (Shortcuts + the tree).
    expect(screen.getAllByRole('button', { name: /Alpha Platform, at risk/ })).toHaveLength(2);
  });

  it('shows standalone (no-program) projects under Projects', () => {
    renderRail();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Standalone Site, health unknown, 4 open tasks/ }),
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

  it('shows the OSS Resources link and a disabled, grayed-out Portfolio rollup row in the community edition (#1173, rule 177)', () => {
    renderRail();
    // Organization group is present for the OSS Resources catalog...
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    // ...and the cross-program Portfolio rollup is neither hidden (reads as
    // broken OSS) nor promoted (it is not purchasable until post-1.0): it is a
    // disabled, grayed-out row with the gate carried in its accessible name.
    const gate = screen.getByRole('button', {
      name: 'Portfolio rollup — available in TruePPM Enterprise (post-1.0)',
    });
    expect(gate).toBeDisabled();
    expect(gate).toHaveAttribute('title', 'Available in TruePPM Enterprise (post-1.0)');
    expect(gate).toHaveTextContent('Portfolio rollup');
    // It is not a navigation link — there is no upsell route.
    expect(
      screen.queryByRole('link', { name: /Portfolio rollup/i }),
    ).not.toBeInTheDocument();
  });

  it('fully hides the desktop rail when collapsed — inert + out of the a11y tree (ADR-0127, supersedes #1176)', () => {
    // User-controlled collapse so the mount-time resize effect leaves it collapsed.
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();
    // There is no icon rail anymore: collapsing hides the rail entirely (0px,
    // inert + aria-hidden), so its nav links leave the accessibility tree —
    // the unified shell bar ≡ is the re-open affordance.
    const rail = document.getElementById('primary-nav-rail');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    expect(rail).toHaveAttribute('inert');
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
  });
});
