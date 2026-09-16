import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceAttachmentsPage } from './WorkspaceAttachmentsPage';
import type { WorkspaceSettings } from '../hooks/useWorkspaceSettings';

const mockState = vi.hoisted(() => ({
  ws: undefined as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

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
  mcHistoryAttributionAudience: 'admin_owner',
  mcHistoryOverridePolicy: 'suggest',
  taskDurationChangePercentPolicy: 'prorate',
  taskDurationChangePercentOverridePolicy: 'suggest',
  estimationScale: 'fibonacci',
  sprintPickerReadyOnlyDefault: true,
  methodology: 'HYBRID',
  methodologyOverridePolicy: 'suggest',
  attachmentsEnabled: true,
  feedbackEnabled: true,
  feedbackUrl: '',
  allowedAttachmentTypes: ['application/pdf'],
  attachmentsOverridePolicy: 'suggest',
  calendar: null,
  calendarOverridePolicy: 'suggest',
  logoUrl: null,
};

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({
    data: mockState.ws,
    isLoading: mockState.isLoading,
    isError: mockState.isError,
    refetch: mockState.refetch,
  }),
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
  mockState.isLoading = false;
  mockState.isError = false;
  mockState.refetch.mockReset();
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

  it('renders FieldHelp ⓘ triggers on the attachment fields (web-rule 263 / #2266)', () => {
    render(<WorkspaceAttachmentsPage />);
    expect(
      screen.getByRole('button', { name: 'About the File attachments options' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'About the Allowed file types options' }),
    ).toBeInTheDocument();
  });
});

describe('WorkspaceAttachmentsPage — failed GET (#3542)', () => {
  // Before the fix, `isLoading || !ws` never cleared on a failed GET (`isLoading`
  // settles to false on a terminal failure, but `!ws` stays true forever) — the
  // page pulsed two skeleton placeholders with no error and no retry.
  it('renders an error with Retry, not a perpetual skeleton, when the settings GET fails', () => {
    mockState.ws = undefined;
    mockState.isLoading = false;
    mockState.isError = true;
    const { container } = render(<WorkspaceAttachmentsPage />);

    expect(screen.getByText("Couldn't load attachment settings.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
    expect(screen.queryByRole('radio', { name: /May narrow or widen these types/i })).toBeNull();
  });

  it('retries the settings query on click', async () => {
    const user = userEvent.setup();
    mockState.ws = undefined;
    mockState.isError = true;
    render(<WorkspaceAttachmentsPage />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockState.refetch).toHaveBeenCalledTimes(1);
  });
});
