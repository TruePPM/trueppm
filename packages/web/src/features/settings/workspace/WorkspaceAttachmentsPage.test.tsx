import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceAttachmentsPage } from './WorkspaceAttachmentsPage';
import type { WorkspaceSettings } from '../hooks/useWorkspaceSettings';

const mockState = vi.hoisted(() => ({ ws: undefined as unknown }));

const WS: WorkspaceSettings = {
  name: 'TrueScope',
  subdomain: 'truescope',
  timezone: 'America/New_York',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  fiscalYearStartDisplay: 'January 1',
  workWeek: [true, true, true, true, true, false, false],
  defaultProjectView: 'overview',
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
// EnterpriseBadge reads the edition — community so the upsell badge renders.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: vi.fn(() => ({ edition: 'community', isLoading: false })),
}));

beforeEach(() => {
  mockState.ws = { ...WS };
});

describe('WorkspaceAttachmentsPage — override policy (#2014)', () => {
  it('checks "May narrow or widen these types" when the stored policy is suggest', () => {
    mockState.ws = { ...WS, attachmentsOverridePolicy: 'suggest' };
    render(<WorkspaceAttachmentsPage />);
    expect(
      screen.getByRole('radio', { name: /May narrow or widen these types/i }),
    ).toBeChecked();
  });

  it('gates the attachments Enforce radio as an Enterprise affordance (disabled + sr hint)', () => {
    render(<WorkspaceAttachmentsPage />);
    const enforce = screen.getByRole('radio', { name: /Enforce attachments workspace-wide/i });
    expect(enforce).toBeDisabled();
    const hintId = enforce.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toMatch(/Enterprise/i);
  });
});
