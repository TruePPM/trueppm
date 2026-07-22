/**
 * RetentionPurgePage — RunStateBadge unit tests + full-page behavior tests.
 *
 * RunStateBadge (top block) is a pure presentational component focused on the
 * "running" status dot's reduced-motion behavior (WCAG 2.3.3, issue 1027).
 *
 * The RetentionPurgePage block mounts the whole operator page over mocked
 * useRetention hooks and the shared settings save store, exercising: the loading
 * skeleton, the 403 vs generic error branches (+ retry), the populated policy
 * table (always-on vs disablable toggles), the lowering-impact warning
 * (fetching / error / data branches), the dry-run and confirm-purge flows, the
 * runs log (empty vs populated, dry-run "(est)", duration formatting), the
 * schedule fields (daily / weekly / off gating), and the dirty-form save + reset
 * contract via the save store.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RunStateBadge, RetentionPurgePage } from './RetentionPurgePage';
import { renderWithProviders } from '@/test/utils';
import { useSettingsSaveStore } from '../../hooks/useSettingsSaveStore';
import type {
  PurgeRun,
  PurgeRunState,
  PurgeRunTrigger,
  RetentionState,
  RetentionUpdatePayload,
} from '@/hooks/useRetention';

// ---------------------------------------------------------------------------
// Mock the retention hooks. importActual keeps the real types/constants so the
// page's non-hook imports (keys, interfaces) are untouched.
// ---------------------------------------------------------------------------

const useRetentionSettings = vi.fn();
const useUpdateRetention = vi.fn();
const useRetentionImpact = vi.fn();
const useRunPurge = vi.fn();

vi.mock('@/hooks/useRetention', async () => {
  const actual = await vi.importActual('@/hooks/useRetention');
  return {
    ...actual,
    useRetentionSettings: () => useRetentionSettings() as unknown,
    useUpdateRetention: () => useUpdateRetention() as unknown,
    useRetentionImpact: (key: string, value: number, enabled: boolean) =>
      useRetentionImpact(key, value, enabled) as unknown,
    useRunPurge: () => useRunPurge() as unknown,
  };
});

function makeRun(overrides: Partial<PurgeRun> = {}): PurgeRun {
  return {
    id: 'run-1',
    started_at: '2026-04-29T10:00:00Z',
    finished_at: null,
    trigger: 'manual' as PurgeRunTrigger,
    state: 'running' as PurgeRunState,
    tables: [],
    rows_deleted: 0,
    bytes_freed: null,
    error: '',
    duration_ms: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<RetentionState> = {}): RetentionState {
  return {
    policies: [
      {
        key: 'TRUEPPM_AUDIT_LOG_RETENTION_DAYS',
        label: 'Audit log',
        note: 'Signed audit trail entries.',
        unit: 'days',
        value: 90,
        enabled: true,
        row_count: 12345,
        bytes: 480000000,
      },
      {
        key: 'TRUEPPM_SYNC_BATCH_RETENTION_HOURS',
        label: 'Sync batches',
        note: 'Offline sync deltas.',
        unit: 'hours',
        value: 48,
        enabled: true,
        row_count: 500,
        bytes: 1536,
      },
    ],
    schedule: {
      frequency: 'daily',
      time_of_day_utc: '02:00:00',
      day_of_week: null,
      on_failure: 'continue',
    },
    runs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RunStateBadge (pure)
// ---------------------------------------------------------------------------

describe('RetentionPurgePage / RunStateBadge', () => {
  it('gates the running-dot pulse behind motion-safe with a non-animated ring fallback', () => {
    const { container } = render(<RunStateBadge run={makeRun({ state: 'running' })} />);

    const dot = container.querySelector('[class*="motion-safe:animate-pulse"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('motion-safe:animate-pulse');
    expect(dot?.className).not.toMatch(/(?<!:)animate-pulse/);
    expect(dot?.className).toContain('ring-2');
    expect(dot?.className).toContain('ring-brand-primary/40');
  });

  it('does not animate non-running states', () => {
    const { container } = render(<RunStateBadge run={makeRun({ state: 'ok' })} />);
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
  });

  it('renders a neutral "Dry run" badge for a completed dry-run trigger', () => {
    render(<RunStateBadge run={makeRun({ trigger: 'dry_run', state: 'ok' })} />);
    expect(screen.getByText('Dry run')).toBeInTheDocument();
  });

  it('shows the running badge even for a dry-run that is still in flight', () => {
    render(<RunStateBadge run={makeRun({ trigger: 'dry_run', state: 'running' })} />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Dry run')).not.toBeInTheDocument();
  });

  it.each([
    ['ok', 'OK'],
    ['partial', 'Partial'],
    ['failed', 'Failed'],
  ] as const)('maps the %s state to the "%s" label', (state, label) => {
    render(<RunStateBadge run={makeRun({ trigger: 'manual', state })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

describe('RetentionPurgePage', () => {
  const refetch = vi.fn();
  const updateMutate = vi
    .fn<(payload: RetentionUpdatePayload) => Promise<void>>()
    .mockResolvedValue(undefined);
  const runMutate = vi.fn().mockResolvedValue({ queued: true, run_id: 'r-9' });

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsSaveStore.getState().reset();
    useRetentionSettings.mockReturnValue({
      data: makeState(),
      isLoading: false,
      error: null,
      refetch,
    });
    useUpdateRetention.mockReturnValue({ mutateAsync: updateMutate, isPending: false });
    useRunPurge.mockReturnValue({ mutateAsync: runMutate, isPending: false });
    useRetentionImpact.mockReturnValue({ data: undefined, isFetching: false, isError: false });
  });

  it('renders the loading skeleton while settings are loading', () => {
    useRetentionSettings.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch });
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByLabelText('Loading retention settings')).toBeInTheDocument();
    // The header/table have not rendered yet.
    expect(screen.queryByText('Retention windows')).not.toBeInTheDocument();
  });

  it('shows an admin-required message (no retry) on a 403', () => {
    const err = Object.assign(new Error('Forbidden'), {
      isAxiosError: true,
      response: { status: 403 },
    });
    useRetentionSettings.mockReturnValue({ data: undefined, isLoading: false, error: err, refetch });
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByText(/Admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a generic error with a working Retry button on a non-403 failure', async () => {
    const user = userEvent.setup();
    useRetentionSettings.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('network down'),
      refetch,
    });
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByText(/the API may be unreachable/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the populated policy table with estimates and both card headings', () => {
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByRole('heading', { name: 'Retention & purge' })).toBeInTheDocument();
    expect(screen.getByText('Retention windows')).toBeInTheDocument();
    expect(screen.getByText('Purge schedule')).toBeInTheDocument();
    expect(screen.getByText('Recent purges')).toBeInTheDocument();

    // Policy labels + PostgreSQL estimates (formatBytes: 480000000 -> ~458 MB).
    expect(screen.getByText('Audit log')).toBeInTheDocument();
    expect(screen.getByText('~12,345')).toBeInTheDocument();
    expect(screen.getByText('~458 MB')).toBeInTheDocument();
  });

  it('offers a toggle for a disablable policy but "Always on" for the sync-batch policy', () => {
    renderWithProviders(<RetentionPurgePage />);
    // Disablable policy has a role=switch toggle.
    expect(
      screen.getByRole('switch', { name: 'Enable Audit log purge' }),
    ).toBeInTheDocument();
    // Non-disablable sync-batch policy shows "Always on" instead of a switch.
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Enable Sync batches purge' }),
    ).not.toBeInTheDocument();
  });

  it('disables a policy value input when its toggle is switched off', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    const input = screen.getByLabelText<HTMLInputElement>('Audit log retention, days');
    expect(input).toBeEnabled();

    await user.click(screen.getByRole('switch', { name: 'Enable Audit log purge' }));
    expect(input).toBeDisabled();
  });

  it('flags a lowered value and surfaces the impact estimate', () => {
    useRetentionImpact.mockReturnValue({
      data: { eligible_rows: 4200, eligible_bytes: 1536 },
      isFetching: false,
      isError: false,
    });
    renderWithProviders(<RetentionPurgePage />);
    const input = screen.getByLabelText<HTMLInputElement>('Audit log retention, days');
    fireEvent.change(input, { target: { value: '30' } });

    // "Lowering" chip appears immediately (not debounced).
    expect(screen.getByText('Lowering')).toBeInTheDocument();
    // Impact estimate row renders the eligible-row count.
    expect(screen.getByText('~4,200')).toBeInTheDocument();
    expect(screen.getByText(/purge-eligible/i)).toBeInTheDocument();
  });

  it('shows the "checking impact" state while the impact query is fetching', () => {
    useRetentionImpact.mockReturnValue({ data: undefined, isFetching: true, isError: false });
    renderWithProviders(<RetentionPurgePage />);
    fireEvent.change(screen.getByLabelText('Audit log retention, days'), {
      target: { value: '30' },
    });
    expect(screen.getByText(/Checking impact/i)).toBeInTheDocument();
  });

  it('shows a fallback message when the impact estimate errors', () => {
    useRetentionImpact.mockReturnValue({ data: undefined, isFetching: false, isError: true });
    renderWithProviders(<RetentionPurgePage />);
    fireEvent.change(screen.getByLabelText('Audit log retention, days'), {
      target: { value: '30' },
    });
    expect(screen.getByText(/Couldn't estimate impact/i)).toBeInTheDocument();
  });

  it('clamps a policy value input to a minimum of 1', () => {
    renderWithProviders(<RetentionPurgePage />);
    const input = screen.getByLabelText<HTMLInputElement>('Audit log retention, days');
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });

  it('queues a dry run and surfaces the confirmation banner', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(runMutate).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/Dry run queued/i)).toBeInTheDocument();
  });

  it('opens the confirm dialog and cancels without purging', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    await user.click(screen.getByRole('button', { name: 'Run purge now' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(runMutate).not.toHaveBeenCalled();
  });

  it('runs the real purge after confirming', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    await user.click(screen.getByRole('button', { name: 'Run purge now' }));
    await user.click(screen.getByRole('button', { name: 'Run purge' }));

    expect(runMutate).toHaveBeenCalledWith(false);
    expect(await screen.findByText(/Purge queued/i)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('closes the confirm dialog on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    await user.click(screen.getByRole('button', { name: 'Run purge now' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
  });

  it('disables both run buttons while a purge is pending', () => {
    useRunPurge.mockReturnValue({ mutateAsync: runMutate, isPending: true });
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run purge now' })).toBeDisabled();
  });

  it('renders the empty-state message when there are no purge runs', () => {
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByText(/No purges recorded yet/i)).toBeInTheDocument();
  });

  it('renders a populated runs log with duration, completed tables, and dry-run estimate marker', () => {
    useRetentionSettings.mockReturnValue({
      data: makeState({
        runs: [
          makeRun({
            id: 'r-ok',
            trigger: 'manual',
            state: 'ok',
            duration_ms: 4200,
            rows_deleted: 1500,
            bytes_freed: 1536,
            tables: [
              { key: 'a', label: 'A', rows: 1, bytes: 1, state: 'ok', error: '' },
              { key: 'b', label: 'B', rows: 1, bytes: 1, state: 'failed', error: 'x' },
            ],
          }),
          makeRun({
            id: 'r-dry',
            trigger: 'dry_run',
            state: 'ok',
            duration_ms: null,
            rows_deleted: 99,
            bytes_freed: null,
          }),
        ],
      }),
      isLoading: false,
      error: null,
      refetch,
    });
    renderWithProviders(<RetentionPurgePage />);

    // Duration formats to seconds with one decimal; null renders an em dash.
    expect(screen.getByText('4.2s')).toBeInTheDocument();
    // Completed tables count: 1 of 2 in "ok".
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    // Dry-run rows are annotated as an estimate.
    expect(screen.getByText(/99\s*\(est\)/)).toBeInTheDocument();
  });

  it('reveals the day-of-week select only when the schedule is weekly', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.queryByLabelText('Day of week')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    expect(screen.getByLabelText('Day of week')).toBeInTheDocument();
    // Weekly seeds day_of_week to Monday (index 0).
    expect(screen.getByLabelText<HTMLInputElement>('Day of week').value).toBe('0');
  });

  it('disables the time-of-day input when the schedule is turned off', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    expect(screen.getByLabelText('Time of day')).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: 'Off' }));
    expect(screen.getByLabelText('Time of day')).toBeDisabled();
    // On-failure radios also disable under "off".
    expect(
      screen.getByRole('radio', { name: /Continue and flag/i }),
    ).toBeDisabled();
  });

  it('lets the operator switch the on-failure behavior to "stop"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetentionPurgePage />);
    const stop = screen.getByRole('radio', { name: /Stop the run on first error/i });
    expect(stop).not.toBeChecked();
    await user.click(stop);
    expect(stop).toBeChecked();
  });

  it('saves the edited policies through the dirty-form save contract', async () => {
    renderWithProviders(<RetentionPurgePage />);
    fireEvent.change(screen.getByLabelText('Audit log retention, days'), {
      target: { value: '30' },
    });

    // The save store now sees a dirty section.
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const payload = updateMutate.mock.calls[0][0];
    expect(payload.policies).toContainEqual({
      key: 'TRUEPPM_AUDIT_LOG_RETENTION_DAYS',
      value: 30,
      enabled: true,
    });
  });

  it('reverts edits through the dirty-form discard contract', async () => {
    renderWithProviders(<RetentionPurgePage />);
    const input = screen.getByLabelText<HTMLInputElement>('Audit log retention, days');
    fireEvent.change(input, { target: { value: '30' } });
    expect(input.value).toBe('30');
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    act(() => {
      useSettingsSaveStore.getState().triggerDiscard();
    });

    await waitFor(() => expect(input.value).toBe('90'));
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
  });
});
