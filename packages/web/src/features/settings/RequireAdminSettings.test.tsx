import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequireAdminSettings } from './RequireAdminSettings';
import type { AdminSettingsVerdict } from '@/hooks/useAdminSettingsAccess';

const mockAccess = vi.hoisted(() => ({
  verdict: 'loading' as AdminSettingsVerdict,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useAdminSettingsAccess', () => ({
  useAdminSettingsAccess: () => mockAccess,
}));

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/settings/health']}>
      <Routes>
        <Route
          path="/settings/health"
          element={
            <RequireAdminSettings>
              <div>Admin settings content</div>
            </RequireAdminSettings>
          }
        />
        <Route path="/me/settings/notifications" element={<div>Personal notifications</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAccess.refetch = vi.fn();
});

describe('RequireAdminSettings', () => {
  it('renders the admin settings shell for an admin', () => {
    mockAccess.verdict = 'admin';
    renderGuard();
    expect(screen.getByText('Admin settings content')).toBeInTheDocument();
  });

  it('redirects a non-admin to their personal settings (#856)', () => {
    mockAccess.verdict = 'not-admin';
    renderGuard();
    expect(screen.queryByText('Admin settings content')).not.toBeInTheDocument();
    expect(screen.getByText('Personal notifications')).toBeInTheDocument();
  });

  // #3350, mirroring #3330. The two halves of the old fall-through. Neither may
  // admit — that was the fail-open default this issue replaced — and neither may
  // redirect, because bouncing a real admin off a slow or blipping /auth/me is the
  // lockout the old default existed to prevent. They differ in what they render.
  describe('with no verdict yet (#3350)', () => {
    it('renders a skeleton while /auth/me is in flight — no admit, no flash-redirect', () => {
      mockAccess.verdict = 'loading';
      renderGuard();

      expect(screen.queryByText('Admin settings content')).not.toBeInTheDocument();
      expect(screen.queryByText('Personal notifications')).not.toBeInTheDocument();
      // `exact: true` is implied by RTL's full-string match on a plain string
      // `name`, unlike Playwright's substring default — so this cannot pass on an
      // unrelated ghost that merely contains "Loading".
      expect(screen.getByRole('status', { name: 'Loading settings…' })).toBeInTheDocument();
    });

    it('renders an error with a retry when /auth/me failed — never an endless skeleton (rule 246, #3298)', async () => {
      mockAccess.verdict = 'unknown';
      renderGuard();

      expect(screen.queryByText('Admin settings content')).not.toBeInTheDocument();
      expect(screen.queryByText('Personal notifications')).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'Loading settings…' })).not.toBeInTheDocument();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent("Couldn't confirm your settings access.");

      // The retry is the way back out: `retry: false` on the /auth/me query makes
      // one failed read terminal, so without this an admin is stuck.
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(mockAccess.refetch).toHaveBeenCalledTimes(1);
    });

    it('never renders the settings children on either no-verdict state', () => {
      const noVerdict = ['loading', 'unknown'] as const;
      // Non-zero denominator: a loop over an emptied array passes silently, which
      // is the one way this assertion could stop meaning anything.
      expect(noVerdict).toHaveLength(2);
      for (const verdict of noVerdict) {
        mockAccess.verdict = verdict;
        const { unmount } = renderGuard();
        expect(screen.queryByText('Admin settings content')).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
