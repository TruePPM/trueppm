import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { WorkspaceGeneralPage } from './WorkspaceGeneralPage';
import type { WorkspaceSettings } from '../hooks/useWorkspaceSettings';

// The page is fully hook-backed; mock the data/mutation/dirty-form hooks so it
// renders without a QueryClientProvider. The dirty-form hook is a side effect
// (returns void), so a no-op mock is sufficient.
const WS: WorkspaceSettings = {
  name: 'TrueScope',
  subdomain: 'truescope',
  timezone: 'America/New_York',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  fiscalYearStartDisplay: 'January 1',
  workWeek: [true, true, true, true, true, false, false],
  defaultProjectView: 'Overview',
  allowGuests: false,
  publicSharing: false,
};

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: WS, isLoading: false }),
}));
vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useDirtyForm', () => ({
  useDirtyForm: () => undefined,
}));
// EnterpriseBadge reads the edition — community so the upsell badge renders.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: vi.fn(() => ({ edition: 'community', isLoading: false })),
}));

// A <Link> to the danger page needs a Router context.
function renderPage() {
  return render(
    <MemoryRouter>
      <WorkspaceGeneralPage />
    </MemoryRouter>,
  );
}

describe('WorkspaceGeneralPage — unwired buttons (#969, #641, Enterprise)', () => {
  it('treats "View change history" as an Enterprise affordance (disabled + EE badge)', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'View change history' })).toBeDisabled();
    const ee = screen.getByRole('link', { name: /Available in TruePPM Enterprise/i });
    expect(ee).toHaveAttribute('href', 'https://trueppm.com/enterprise');
  });

  it('disables the unwired OSS buttons (logo replace + add calendar) with the #969 reference', () => {
    renderPage();
    const replace = screen.getByRole('button', { name: 'Replace' });
    const addCalendar = screen.getByRole('button', { name: '+ Add calendar' });
    expect(replace).toBeDisabled();
    expect(addCalendar).toBeDisabled();
    expect(replace).toHaveAttribute('title', expect.stringContaining('#969'));
    expect(addCalendar).toHaveAttribute('title', expect.stringContaining('#969'));
  });

  it('points the danger zone at the dedicated Archive / Delete page (#641 wired)', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Go to Archive \/ Delete/i });
    expect(link).toHaveAttribute('href', '/settings/danger');
    // The old "in progress (#641)" stub and its disabled buttons are gone.
    expect(screen.queryByRole('button', { name: 'Export all data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace…' })).not.toBeInTheDocument();
  });

  it('keeps the wired controls (workspace name input) interactive', () => {
    renderPage();
    expect(screen.getByDisplayValue('TrueScope')).toBeEnabled();
  });

  it('derives the toggle word from state so it never contradicts the switch (#978)', async () => {
    const user = userEvent.setup();
    renderPage();
    const publicSharing = screen.getByRole('switch', { name: 'Allow public link sharing' });
    // Off (fixture default): reads "Disabled", no stray "Enabled" on the page.
    expect(publicSharing).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
    // Turning it on flips the visible word with the switch — no green "Disabled".
    await user.click(publicSharing);
    expect(publicSharing).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });
});
