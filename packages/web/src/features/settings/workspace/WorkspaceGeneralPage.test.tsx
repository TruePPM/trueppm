import { render, screen, within } from '@testing-library/react';
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
  iterationLabel: 'Sprint',
  iterationLabelOverridePolicy: 'suggest',
  mcHistoryEnabled: true,
  mcHistoryRetentionCap: 100,
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
  mcHistoryOverridePolicy: 'allow',
  methodology: 'HYBRID',
  methodologyOverridePolicy: 'suggest',
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
    const historyBtn = screen.getByRole('button', { name: 'View change history' });
    expect(historyBtn).toBeDisabled();
    // Scope to the badge alongside this button — there is now a second EE badge on
    // the iteration-terminology "Enforce" policy (#1106).
    const ee = within(historyBtn.parentElement as HTMLElement).getByRole('link', {
      name: /Available in TruePPM Enterprise/i,
    });
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

  it('points the danger zone at the in-page Archive / Delete section (#641 wired, #1248 anchored)', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Go to Archive \/ Delete/i });
    // Danger is now an anchored section on the consolidated settings page
    // (ADR-0146), so it deep-links to the #danger anchor rather than a route.
    expect(link.getAttribute('href')).toContain('#danger');
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

// ----- Forecast history (ADR-0144, #1232) ------------------------------------

describe('WorkspaceGeneralPage — forecast history', () => {
  it('renders the forecast-history group seeded from the workspace settings', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /forecast history/i, level: 3 })).toBeInTheDocument();
    // The workspace root is non-null: a plain switch, number input, and select.
    expect(
      screen.getByRole('switch', { name: 'Keep Monte Carlo run history' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Run history limit' })).toHaveValue(100);
    expect(screen.getByRole('combobox', { name: 'Run attribution visible to' })).toHaveValue(
      'ADMIN_OWNER',
    );
  });

  it('clamps the retention input to the 500 hard cap', async () => {
    const user = userEvent.setup();
    renderPage();
    const cap = screen.getByRole('spinbutton', { name: 'Run history limit' });
    await user.clear(cap);
    await user.type(cap, '9999');
    expect(cap).toHaveValue(500);
  });

  it('renders the Lock policy as a disabled Enterprise affordance with an EE badge', () => {
    renderPage();
    const lock = screen.getByRole('radio', { name: /Lock workspace-wide/i });
    expect(lock).toBeDisabled();
    // The "May override" radio is the live OSS default.
    expect(screen.getByRole('radio', { name: /May override these settings/i })).toBeChecked();
    // The EE badge sits beside the disabled Lock option.
    const ee = within(lock.closest('span') as HTMLElement).getByRole('link', {
      name: /Available in TruePPM Enterprise/i,
    });
    expect(ee).toHaveAttribute('href', 'https://trueppm.com/enterprise');
  });
});
