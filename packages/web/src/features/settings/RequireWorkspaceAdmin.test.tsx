import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequireWorkspaceAdmin } from './RequireWorkspaceAdmin';
import type { WorkspaceAdminVerdict } from '@/hooks/useIsWorkspaceAdmin';

const mockStatus = vi.hoisted(() => ({
  verdict: 'loading' as WorkspaceAdminVerdict,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useIsWorkspaceAdmin', () => ({
  useWorkspaceAdminStatus: () => mockStatus,
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

beforeEach(() => {
  mockStatus.refetch = vi.fn();
});

describe('RequireWorkspaceAdmin', () => {
  it('renders the workspace settings for a workspace admin', () => {
    mockStatus.verdict = 'admin';
    renderGuard();
    expect(screen.getByText('Workspace settings content')).toBeInTheDocument();
  });

  it('redirects a non-workspace-admin to their personal settings (#2012)', () => {
    mockStatus.verdict = 'not-admin';
    renderGuard();
    expect(screen.queryByText('Workspace settings content')).not.toBeInTheDocument();
    expect(screen.getByText('Personal notifications')).toBeInTheDocument();
  });

  // #3330. The two halves of the old `null` verdict. Neither may admit — that was
  // the fail-open default this issue replaced — and neither may redirect, because
  // bouncing a real admin off a slow or blipping /auth/me is the lockout the old
  // default existed to prevent. They differ in what they render instead.
  describe('with no verdict yet (#3330)', () => {
    it('renders a skeleton while /auth/me is in flight — no admit, no flash-redirect', () => {
      mockStatus.verdict = 'loading';
      renderGuard();

      expect(screen.queryByText('Workspace settings content')).not.toBeInTheDocument();
      expect(screen.queryByText('Personal notifications')).not.toBeInTheDocument();
      // `exact: true` — `getByRole` name matching is a substring match, so a bare
      // /Loading/ would also match an unrelated ghost and make this vacuous.
      expect(
        screen.getByRole('status', { name: 'Loading workspace settings…' }),
      ).toBeInTheDocument();
    });

    it('renders an error with a retry when /auth/me failed — never an endless skeleton (rule 246, #3298)', async () => {
      mockStatus.verdict = 'unknown';
      renderGuard();

      expect(screen.queryByText('Workspace settings content')).not.toBeInTheDocument();
      expect(screen.queryByText('Personal notifications')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('status', { name: 'Loading workspace settings…' }),
      ).not.toBeInTheDocument();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent("Couldn't confirm your workspace role.");

      // The retry is the way back out: `retry: false` on the /auth/me query makes
      // one failed read terminal, so without this an admin is stuck.
      // A plain string `name` in RTL is a full-string match (unlike Playwright's
      // substring default), so this cannot pass on a differently-labelled button.
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(mockStatus.refetch).toHaveBeenCalledTimes(1);
    });

    it('never renders the settings children on either no-verdict state', () => {
      const noVerdict = ['loading', 'unknown'] as const;
      // Non-zero denominator: a loop over an emptied array passes silently, which
      // is the one way this assertion could stop meaning anything.
      expect(noVerdict).toHaveLength(2);
      for (const verdict of noVerdict) {
        mockStatus.verdict = verdict;
        const { unmount } = renderGuard();
        expect(screen.queryByText('Workspace settings content')).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
