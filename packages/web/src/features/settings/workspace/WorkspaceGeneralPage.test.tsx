import { render, screen } from '@testing-library/react';
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

describe('WorkspaceGeneralPage — unwired buttons (#791, #641, Enterprise)', () => {
  it('treats "View change history" as an Enterprise affordance (disabled + EE badge)', () => {
    render(<WorkspaceGeneralPage />);
    expect(screen.getByRole('button', { name: 'View change history' })).toBeDisabled();
    const ee = screen.getByRole('link', { name: /Available in TruePPM Enterprise/i });
    expect(ee).toHaveAttribute('href', 'https://trueppm.com/enterprise');
  });

  it('disables the unwired OSS buttons (logo replace + add calendar) with the #791 reference', () => {
    render(<WorkspaceGeneralPage />);
    const replace = screen.getByRole('button', { name: 'Replace' });
    const addCalendar = screen.getByRole('button', { name: '+ Add calendar' });
    expect(replace).toBeDisabled();
    expect(addCalendar).toBeDisabled();
    expect(replace).toHaveAttribute('title', expect.stringContaining('#791'));
    expect(addCalendar).toHaveAttribute('title', expect.stringContaining('#791'));
  });

  it('disables the danger-zone actions until the lifecycle endpoints (#641) ship', () => {
    render(<WorkspaceGeneralPage />);
    // Disabled via the StubFieldset wrapper; jest-dom resolves the disabled
    // ancestor fieldset for each descendant button.
    expect(screen.getByRole('button', { name: 'Export all data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Transfer ownership' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete workspace…' })).toBeDisabled();
    // The #641 tracking link is reachable (outside the disabled fieldset).
    const link = screen.getByRole('link', { name: '#641' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/issues/641'));
  });

  it('keeps the wired controls (workspace name input) interactive', () => {
    render(<WorkspaceGeneralPage />);
    expect(screen.getByDisplayValue('TrueScope')).toBeEnabled();
  });
});
