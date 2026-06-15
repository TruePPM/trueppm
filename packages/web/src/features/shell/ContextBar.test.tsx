import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { useShellStore } from '@/stores/shellStore';
import { ContextBar } from './ContextBar';

// Route + data hooks are driven by these mutable fixtures so each test can pick a
// context (project route / program route / unscoped) without a router round-trip.
let projectId: string | undefined;
let programId: string | undefined;
let projectData: unknown;
let programData: unknown;

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => programId }));
vi.mock('@/hooks/useProject', () => ({ useProject: () => ({ data: projectData }) }));
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => ({ data: programData }) }));
vi.mock('@/features/programs/ProgramIdentitySquare', () => ({
  ProgramIdentitySquare: () => <span data-testid="identity-square" aria-hidden="true" />,
}));
// The "+ New" affordance owns its own data hooks (role / backlog / program) and is
// covered by CreateMenu.test.tsx; stub it here so ContextBar tests don't fire its XHRs.
vi.mock('./CreateMenu', () => ({ CreateMenu: () => null }));

function renderBar() {
  return render(
    <MemoryRouter>
      <ContextBar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  projectId = undefined;
  programId = undefined;
  projectData = undefined;
  programData = undefined;
  useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
});

describe('ContextBar', () => {
  it('builds Workspace › Program › Project on a project route, project as the leaf', () => {
    projectId = 'proj-1';
    projectData = { id: 'proj-1', name: 'Launch Site', program_detail: { id: 'prog-1', name: 'Apollo' } };
    programData = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
    renderBar();

    expect(screen.getByRole('link', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apollo' })).toHaveAttribute(
      'href',
      '/programs/prog-1/overview',
    );
    expect(screen.getByText('Launch Site')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('identity-square')).toBeInTheDocument();
  });

  it('shows the program as the leaf on a program route', () => {
    programId = 'prog-1';
    programData = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
    renderBar();

    expect(screen.getByText('Apollo')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Apollo' })).not.toBeInTheDocument();
  });

  it('renders just the Workspace root on an unscoped route', () => {
    renderBar();
    const items = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(items).toHaveTextContent('Workspace');
    expect(items).not.toHaveTextContent('›');
  });

  it('toggles the rail and reflects state via aria-expanded', () => {
    renderBar();
    const toggle = screen.getByRole('button', { name: 'Hide navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    // Re-query: the label/aria flip once collapsed.
    expect(screen.getByRole('button', { name: 'Show navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
