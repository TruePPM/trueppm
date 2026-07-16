import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { RequireWorkspaceAdmin } from './RequireWorkspaceAdmin';

const mockAdmin = vi.hoisted(() => ({ value: null as boolean | null }));

vi.mock('@/hooks/useIsWorkspaceAdmin', () => ({
  useIsWorkspaceAdmin: () => mockAdmin.value,
}));

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route
          path="/settings"
          element={
            <RequireWorkspaceAdmin>
              <div>Workspace settings content</div>
            </RequireWorkspaceAdmin>
          }
        />
        <Route path="/me/settings/notifications" element={<div>Personal notifications</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireWorkspaceAdmin', () => {
  it('renders the workspace settings for a workspace admin', () => {
    mockAdmin.value = true;
    renderGuard();
    expect(screen.getByText('Workspace settings content')).toBeInTheDocument();
  });

  it('falls through (renders children) while the role signal is unresolved — no flash-redirect', () => {
    mockAdmin.value = null;
    renderGuard();
    expect(screen.getByText('Workspace settings content')).toBeInTheDocument();
  });

  it('redirects a non-workspace-admin to their personal settings (#2012)', () => {
    mockAdmin.value = false;
    renderGuard();
    expect(screen.queryByText('Workspace settings content')).not.toBeInTheDocument();
    expect(screen.getByText('Personal notifications')).toBeInTheDocument();
  });
});
