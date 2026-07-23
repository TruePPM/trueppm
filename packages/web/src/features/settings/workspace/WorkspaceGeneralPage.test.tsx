import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceGeneralPage } from './WorkspaceGeneralPage';
import type { WorkspaceSettings } from '../hooks/useWorkspaceSettings';

// Mutable so a test can vary the loaded settings (e.g. an empty subdomain on a
// self-hosted install) without re-mocking the module (#2013).
const mockState = vi.hoisted(() => ({ ws: undefined as unknown }));

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
  publicSharingOverridePolicy: 'suggest',
  iterationLabel: 'Sprint',
  iterationLabelOverridePolicy: 'suggest',
  mcHistoryEnabled: true,
  mcHistoryRetentionCap: 100,
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
  mcHistoryOverridePolicy: 'suggest',
  taskDurationChangePercentPolicy: 'prorate',
  taskDurationChangePercentOverridePolicy: 'suggest',
  estimationScale: 'fibonacci',
  methodology: 'HYBRID',
  methodologyOverridePolicy: 'suggest',
  attachmentsEnabled: true,
  allowedAttachmentTypes: ['application/pdf'],
  attachmentsOverridePolicy: 'suggest',
  calendar: null,
  calendarOverridePolicy: 'suggest',
  logoUrl: null,
};

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: mockState.ws, isLoading: false }),
}));
vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useDirtyForm', () => ({
  useDirtyForm: () => undefined,
}));
// Logo control (#969) is hook-backed via react-query mutations; stub them so the
// page renders without a QueryClientProvider.
vi.mock('../hooks/useWorkspaceLogo', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useWorkspaceLogo')>(
    '../hooks/useWorkspaceLogo',
  );
  return {
    ...actual,
    useUploadWorkspaceLogo: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteWorkspaceLogo: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
// EnterpriseBadge reads the edition — community so the upsell badge renders.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: vi.fn(() => ({ edition: 'community', isLoading: false })),
}));

// Reset to the default fixture before each test; a test may mutate `mockState.ws`
// afterward to exercise a different loaded state.
beforeEach(() => {
  mockState.ws = { ...WS };
});

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

  it('wires the logo Upload control and keeps the deferred calendar stub disabled', () => {
    renderPage();
    // Logo is wired now (#969): with no logo set the picker reads "Upload" and is
    // enabled. The holiday-calendar stub stays disabled (deferred to #906).
    const upload = screen.getByRole('button', { name: 'Upload' });
    expect(upload).toBeEnabled();
    const addCalendar = screen.getByRole('button', { name: '+ Add calendar' });
    expect(addCalendar).toBeDisabled();
    expect(addCalendar).toHaveAttribute('title', expect.stringContaining('#906'));
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

  it('names the workspace-name field for assistive tech (issue 2199)', () => {
    renderPage();
    // FieldRow's visible label is a plain <div>, so the input needs its own name.
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeInTheDocument();
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

  it('renders the duration-change policy select seeded from the workspace settings', () => {
    renderPage();
    const select = screen.getByRole('combobox', { name: /Duration change to percent complete/i });
    expect(select).toHaveValue('prorate');
    // The shared option labels come from durationChangePolicy.ts.
    expect(within(select).getByRole('option', { name: 'Prorate automatically' })).toBeInTheDocument();
  });

  it('renders the duration-change Enforce policy as a disabled Enterprise affordance', () => {
    renderPage();
    const enforce = screen.getByRole('radio', {
      name: /Force this policy everywhere; overrides are ignored\./i,
    });
    expect(enforce).toBeDisabled();
    expect(
      screen.getByRole('radio', {
        name: /Programs and projects can choose their own policy\./i,
      }),
    ).toBeChecked();
    const ee = within(enforce.closest('span') as HTMLElement).getByRole('link', {
      name: /Available in TruePPM Enterprise/i,
    });
    expect(ee).toHaveAttribute('href', 'https://trueppm.com/enterprise');
    // The Enterprise gate must reach screen readers, not just the visual badge
    // (web-rule 265 / #2001): the disabled radio points at an sr-only hint node.
    const hintId = enforce.getAttribute('aria-describedby');
    expect(hintId).toBe('duration-change-enforce-enterprise-hint');
    expect(document.getElementById(hintId as string)?.textContent).toMatch(
      /requires TruePPM Enterprise/i,
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
    // The Enterprise gate must reach screen readers, not just the visual badge
    // (web-rule 265 / #2001): the disabled radio points at an sr-only hint node.
    const hintId = lock.getAttribute('aria-describedby');
    expect(hintId).toBe('mc-history-enforce-enterprise-hint');
    expect(document.getElementById(hintId as string)?.textContent).toMatch(
      /requires TruePPM Enterprise/i,
    );
  });

  it('exposes the iteration-terminology Enforce gate to screen readers (web-rule 265 / #2001)', () => {
    renderPage();
    const enforce = screen.getByRole('radio', { name: /Enforce workspace-wide/i });
    expect(enforce).toBeDisabled();
    const hintId = enforce.getAttribute('aria-describedby');
    expect(hintId).toBe('iteration-enforce-enterprise-hint');
    expect(document.getElementById(hintId as string)?.textContent).toMatch(
      /requires TruePPM Enterprise/i,
    );
  });
});

// ----- Display-value fixes (#2013) -------------------------------------------

describe('WorkspaceGeneralPage — display fixes (#2013)', () => {
  it('shows the subdomain row for a hosted workspace that has one', () => {
    mockState.ws = { ...WS, subdomain: 'truescope' };
    renderPage();
    expect(screen.getByText('Subdomain')).toBeInTheDocument();
    expect(screen.getByText('truescope')).toBeInTheDocument();
  });

  it('hides the subdomain row on a self-hosted install with no subdomain', () => {
    // A bare `https://.trueppm.app` is meaningless on self-host — the whole row
    // is suppressed rather than rendered empty.
    mockState.ws = { ...WS, subdomain: '' };
    renderPage();
    expect(screen.queryByText('Subdomain')).not.toBeInTheDocument();
    expect(screen.queryByText('.trueppm.app')).not.toBeInTheDocument();
  });

  it('does not fabricate a static guest count on the Allow guests toggle', () => {
    renderPage();
    // The old hardcoded "3 guests currently in the workspace" hint was a lie —
    // there is no client-side count, so no count is shown.
    expect(screen.queryByText(/guests currently in the workspace/i)).not.toBeInTheDocument();
  });

  it('persists the lowercase token for Default project view, not the display label', () => {
    // The saved value must match the model token convention ("board"), not the
    // capitalized option label. A stored capitalized value still selects.
    mockState.ws = { ...WS, defaultProjectView: 'Board' };
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Default project view' });
    expect(select).toHaveValue('board');
    expect(within(select).getByRole('option', { name: 'Board' })).toHaveValue('board');
    expect(within(select).getByRole('option', { name: 'Overview' })).toHaveValue('overview');
  });
});

describe('WorkspaceGeneralPage — public-sharing override policy (#2014)', () => {
  it('checks "May narrow or widen" when the stored policy is suggest', () => {
    mockState.ws = { ...WS, publicSharingOverridePolicy: 'suggest' };
    renderPage();
    const mayOverride = screen.getByRole('radio', { name: /May narrow or widen this default/i });
    expect(mayOverride).toBeChecked();
  });

  it('treats a stored `inherit` as "may override" (OSS honors inherit≡suggest)', () => {
    mockState.ws = { ...WS, publicSharingOverridePolicy: 'inherit' };
    renderPage();
    expect(screen.getByRole('radio', { name: /May narrow or widen this default/i })).toBeChecked();
  });

  it('gates the sharing Enforce radio as an Enterprise affordance (disabled + EE badge + sr hint)', () => {
    renderPage();
    const enforce = screen.getByRole('radio', { name: /Enforce sharing workspace-wide/i });
    expect(enforce).toBeDisabled();
    const hintId = enforce.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toMatch(/Enterprise/i);
  });
});

describe('WorkspaceGeneralPage — contextual help (#2266)', () => {
  // The ⓘ triggers are unconditional (no StubFieldset write-gate on this page),
  // so they are reachable by read-only viewers too.
  it('renders a FieldHelp ⓘ on the jargon/policy/cascade fields', () => {
    renderPage();
    for (const field of [
      'Work week',
      'Iteration terminology',
      'Allow guests',
      'Public sharing',
      'Keep Monte Carlo run history',
      'Run attribution visible to',
    ]) {
      const trigger = screen.getByRole('button', { name: `About the ${field} options` });
      expect(trigger).toBeEnabled();
    }
  });

  it('opens the Public sharing popover and deep-links into the docs site', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'About the Public sharing options' }));
    const dialog = screen.getByRole('dialog', { name: 'Public sharing' });
    // The popover explains the workspace→program→project cascade, not just the toggle.
    expect(within(dialog).getByText(/narrow/i)).toBeInTheDocument();
    const learnMore = within(dialog).getByRole('link', { name: /Sharing & access guide/i });
    expect(learnMore).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/administration/sharing-and-access/#the-two-sharing-settings',
    );
    expect(learnMore).toHaveAttribute('target', '_blank');
  });
});
