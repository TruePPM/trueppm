import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceFeedbackPage } from './WorkspaceFeedbackPage';
import type { WorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { DEFAULT_FEEDBACK_URL } from '@/lib/feedbackContext';

const mockState = vi.hoisted(() => ({
  ws: undefined as unknown,
  isLoading: false,
  mutateAsync: vi.fn(),
  // useDirtyForm is the page's only save path, so the test drives the form
  // through the callbacks the page hands it rather than a Save button.
  dirty: { onSave: undefined as undefined | (() => Promise<void>) },
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
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
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
  useWorkspaceSettings: () => ({ data: mockState.ws, isLoading: mockState.isLoading }),
}));
vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync: mockState.mutateAsync }),
}));
vi.mock('../hooks/useDirtyForm', () => ({
  useDirtyForm: ({ onSave }: { onSave: () => Promise<void> }) => {
    mockState.dirty.onSave = onSave;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockState.ws = { ...WS };
  mockState.isLoading = false;
  mockState.dirty.onSave = undefined;
});

describe('WorkspaceFeedbackPage (#2392)', () => {
  it('titles the page Feedback', () => {
    render(<WorkspaceFeedbackPage />);
    expect(screen.getByText('Feedback')).toBeInTheDocument();
  });

  it('renders a loading skeleton while the settings query is loading', () => {
    mockState.ws = undefined;
    mockState.isLoading = true;
    render(<WorkspaceFeedbackPage />);
    expect(document.querySelector('[class*="animate-pulse"]')).not.toBeNull();
    expect(screen.queryByLabelText('Tracker URL')).not.toBeInTheDocument();
  });

  it('reflects the stored enabled state on the toggle', () => {
    mockState.ws = { ...WS, feedbackEnabled: false };
    render(<WorkspaceFeedbackPage />);
    expect(screen.getByRole('switch', { name: 'Show the report-a-bug control' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('shows the public tracker as a placeholder when no URL is stored', () => {
    render(<WorkspaceFeedbackPage />);
    expect(screen.getByLabelText('Tracker URL')).toHaveAttribute(
      'placeholder',
      DEFAULT_FEEDBACK_URL,
    );
  });

  it('shows the stored tracker URL when the operator has repointed it', () => {
    mockState.ws = { ...WS, feedbackUrl: 'https://helpdesk.internal/new' };
    render(<WorkspaceFeedbackPage />);
    expect(screen.getByLabelText('Tracker URL')).toHaveValue('https://helpdesk.internal/new');
  });

  it('disables the tracker URL while the control is hidden — a closed route is not repointable', async () => {
    render(<WorkspaceFeedbackPage />);
    expect(screen.getByLabelText('Tracker URL')).toBeEnabled();

    await userEvent.click(screen.getByRole('switch', { name: 'Show the report-a-bug control' }));
    expect(screen.getByLabelText('Tracker URL')).toBeDisabled();
  });

  it('trims the tracker URL before saving', async () => {
    mockState.ws = { ...WS, feedbackUrl: '' };
    render(<WorkspaceFeedbackPage />);

    await userEvent.type(screen.getByLabelText('Tracker URL'), '  https://helpdesk.internal/new  ');
    await mockState.dirty.onSave?.();

    await waitFor(() => {
      expect(mockState.mutateAsync).toHaveBeenCalledWith({
        feedbackEnabled: true,
        feedbackUrl: 'https://helpdesk.internal/new',
      });
    });
  });

  it('renders FieldHelp ⓘ triggers on both fields (web-rule 263)', () => {
    render(<WorkspaceFeedbackPage />);
    expect(
      screen.getByRole('button', { name: 'About the Report a bug control options' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'About the Tracker URL options' }),
    ).toBeInTheDocument();
  });
});
