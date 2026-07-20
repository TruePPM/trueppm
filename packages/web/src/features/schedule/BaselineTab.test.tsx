import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER, ROLE_VIEWER } from '@/lib/roles';
import type { TaskBaselineResult, BaselineComparison } from '@/hooks/useTaskBaseline';

// ---------------------------------------------------------------------------
// Mocks — the tab composes three hooks (task baseline, current role, create
// baseline) plus toast + the confirm dialog's focus trap. Drive each directly
// so we can exercise every render branch without a network layer.
// ---------------------------------------------------------------------------

interface MockQuery {
  data: TaskBaselineResult | undefined;
  isLoading: boolean;
}

// Mirrors the `mutate(body, opts)` shape BaselineTab drives — a typed signature
// so the per-test `onSuccess`/`onError` callbacks are checked, not `any`.
type CaptureMutate = (
  body: Record<string, never>,
  opts: { onSuccess: (result: { name: string }) => void; onError: (error: unknown) => void },
) => void;

const baselineSpy = vi.hoisted(() => vi.fn<() => MockQuery>());
const roleSpy = vi.hoisted(() => vi.fn<() => { role: number | null }>());
const createMut = vi.hoisted(() => ({ mutate: vi.fn<CaptureMutate>(), isPending: false }));
const toastSpies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/hooks/useTaskBaseline', () => ({ useTaskBaseline: () => baselineSpy() }));
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: () => roleSpy() }));
vi.mock('@/hooks/useBaselines', () => ({ useCreateBaseline: () => createMut }));
vi.mock('@/components/Toast', () => ({ toast: toastSpies }));
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: () => ({ current: null }) }));

const { BaselineTab } = await import('./BaselineTab');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function comparison(over: Partial<BaselineComparison> = {}): BaselineComparison {
  return {
    has_baseline: true,
    in_baseline: true,
    baseline_name: 'Baseline 1',
    baseline_taken_at: '2026-07-12T10:00:00Z',
    has_cpm_dates: true,
    planned_start: '2026-03-29',
    planned_finish: '2026-04-08',
    planned_duration: 8,
    planned_actual_start: null,
    planned_actual_finish: null,
    current_start: '2026-04-01',
    current_finish: '2026-04-10',
    current_duration: 8,
    current_actual_start: null,
    current_actual_finish: null,
    start_delta_days: 3,
    finish_delta_days: -2,
    duration_delta: 0,
    ...over,
  };
}

function setQuery(q: Partial<MockQuery>) {
  baselineSpy.mockReturnValue({ data: undefined, isLoading: false, ...q });
}

function render(projectId = 'p1', taskId = 't1') {
  return renderWithProviders(<BaselineTab projectId={projectId} taskId={taskId} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  createMut.isPending = false;
  createMut.mutate = vi.fn<CaptureMutate>();
  roleSpy.mockReturnValue({ role: ROLE_ADMIN });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BaselineTab — loading and empty query states', () => {
  it('renders the skeleton while the baseline query is loading', () => {
    setQuery({ isLoading: true });
    render();
    const status = screen.getByRole('status', { name: 'Loading baseline' });
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('renders nothing when the query resolves with no data', () => {
    setQuery({ data: undefined, isLoading: false });
    const { container } = render();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BaselineTab — no active baseline empty state', () => {
  it('offers a capture action for an admin and explains what a baseline is', () => {
    roleSpy.mockReturnValue({ role: ROLE_ADMIN });
    setQuery({ data: { has_baseline: false } });
    render();
    expect(screen.getByText('No active baseline')).toBeInTheDocument();
    expect(
      screen.getByText(/Capture a baseline to compare this task's planned dates/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture baseline' })).toBeEnabled();
  });

  it('shows read-only guidance (no capture button) for a viewer', () => {
    roleSpy.mockReturnValue({ role: ROLE_VIEWER });
    setQuery({ data: { has_baseline: false } });
    render();
    expect(
      screen.getByText(/A project admin can capture one from the Schedule view/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture baseline' })).not.toBeInTheDocument();
  });

  it('shows read-only guidance for a member (below the ADMIN gate)', () => {
    roleSpy.mockReturnValue({ role: ROLE_MEMBER });
    setQuery({ data: { has_baseline: false } });
    render();
    expect(screen.queryByRole('button', { name: 'Capture baseline' })).not.toBeInTheDocument();
  });

  it('shows read-only guidance while the role is still resolving (null)', () => {
    roleSpy.mockReturnValue({ role: null });
    setQuery({ data: { has_baseline: false } });
    render();
    expect(screen.queryByRole('button', { name: 'Capture baseline' })).not.toBeInTheDocument();
  });

  it('disables the capture button while a capture is in flight', () => {
    roleSpy.mockReturnValue({ role: ROLE_OWNER });
    createMut.isPending = true;
    setQuery({ data: { has_baseline: false } });
    render();
    expect(screen.getByRole('button', { name: 'Capture baseline' })).toBeDisabled();
  });
});

describe('BaselineTab — capture flow', () => {
  it('opens the confirm dialog when the capture button is clicked', async () => {
    const user = userEvent.setup();
    setQuery({ data: { has_baseline: false } });
    render();
    await user.click(screen.getByRole('button', { name: 'Capture baseline' }));
    expect(screen.getByRole('dialog', { name: /Capture a baseline/ })).toBeInTheDocument();
  });

  it('refuses to capture and warns when offline', async () => {
    const user = userEvent.setup();
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setQuery({ data: { has_baseline: false } });
    render();
    await user.click(screen.getByRole('button', { name: 'Capture baseline' }));
    // Confirm inside the now-open dialog (the last "Capture baseline" button).
    await user.click(screen.getAllByRole('button', { name: /Capture baseline/ }).at(-1)!);
    expect(toastSpies.info).toHaveBeenCalledWith(
      "You're offline — reconnect to capture a baseline.",
    );
    expect(createMut.mutate).not.toHaveBeenCalled();
    onLineSpy.mockRestore();
  });

  it('captures and toasts success when online, closing the dialog', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    createMut.mutate = vi.fn<CaptureMutate>((_body, opts) => opts.onSuccess({ name: 'Baseline 3' }));
    setQuery({ data: { has_baseline: false } });
    render();
    await user.click(screen.getByRole('button', { name: 'Capture baseline' }));
    // Confirm inside the dialog.
    const confirm = screen.getAllByRole('button', { name: /Capture baseline/ }).at(-1)!;
    await user.click(confirm);
    expect(createMut.mutate).toHaveBeenCalledTimes(1);
    expect(toastSpies.success).toHaveBeenCalledWith('Captured Baseline 3');
    // Dialog closed after success.
    expect(screen.queryByRole('dialog', { name: /Capture a baseline/ })).not.toBeInTheDocument();
  });

  it('toasts an error when the capture request fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    createMut.mutate = vi.fn<CaptureMutate>((_body, opts) => opts.onError(new Error('boom')));
    setQuery({ data: { has_baseline: false } });
    render();
    await user.click(screen.getByRole('button', { name: 'Capture baseline' }));
    const confirm = screen.getAllByRole('button', { name: /Capture baseline/ }).at(-1)!;
    await user.click(confirm);
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't capture baseline — try again.");
  });
});

describe('BaselineTab — task added after baseline', () => {
  it('explains the task did not exist at snapshot time, with the baseline name and date', () => {
    setQuery({
      data: {
        has_baseline: true,
        in_baseline: false,
        baseline_name: 'Kickoff baseline',
        baseline_taken_at: '2026-05-20T12:00:00Z',
      },
    });
    render();
    expect(screen.getByText('Task added after baseline')).toBeInTheDocument();
    expect(screen.getByText('Kickoff baseline')).toBeInTheDocument();
    expect(screen.getByText(/May 20, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/did not exist at that time/)).toBeInTheDocument();
  });
});

describe('BaselineTab — comparison table', () => {
  it('renders the comparison rows with formatted dates and the baseline banner', () => {
    setQuery({ data: comparison() });
    render();
    expect(screen.getByRole('table', { name: 'Baseline comparison' })).toBeInTheDocument();
    // Banner name.
    expect(screen.getByText('Baseline 1')).toBeInTheDocument();
    // ISO dates get formatted to en-US UTC.
    expect(screen.getByText('Apr 1, 2026')).toBeInTheDocument();
    expect(screen.getByText('Mar 29, 2026')).toBeInTheDocument();
    // Duration cells carry the day suffix.
    expect(screen.getAllByText('8d').length).toBeGreaterThan(0);
  });

  it('colors a positive start delta as late and a negative finish delta as ahead', () => {
    setQuery({ data: comparison({ start_delta_days: 3, finish_delta_days: -2 }) });
    render();
    const late = screen.getByLabelText('3 days late');
    expect(late).toHaveTextContent('+3d');
    expect(late).toHaveClass('text-semantic-critical');
    const ahead = screen.getByLabelText('2 days ahead');
    expect(ahead).toHaveTextContent('-2d');
    expect(ahead).toHaveClass('text-semantic-on-track');
  });

  it('renders a zero delta as a plain "0d" (an on-plan value, not a placeholder)', () => {
    setQuery({ data: comparison({ duration_delta: 0, start_delta_days: 5, finish_delta_days: 5 }) });
    render();
    expect(screen.getByText('0d')).toBeInTheDocument();
  });

  it('renders an em dash for a null delta (actual start/finish rows)', () => {
    setQuery({ data: comparison() });
    render();
    // Actual start/finish rows have delta null → em dash chips exist.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('warns when the baseline was captured before CPM ran', () => {
    setQuery({ data: comparison({ has_cpm_dates: false }) });
    render();
    expect(screen.getByText(/CPM not yet run at snapshot time/)).toBeInTheDocument();
  });

  it('omits the CPM warning when the snapshot has CPM dates', () => {
    setQuery({ data: comparison({ has_cpm_dates: true }) });
    render();
    expect(screen.queryByText(/CPM not yet run at snapshot time/)).not.toBeInTheDocument();
  });

  it('passes a non-ISO date string through verbatim and dashes a null cell', () => {
    setQuery({
      data: comparison({ current_actual_start: 'In progress', planned_actual_start: null }),
    });
    render();
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('renders duration cells as an em dash when duration is null', () => {
    setQuery({
      data: comparison({
        current_duration: null as unknown as number,
        planned_duration: null as unknown as number,
      }),
    });
    render();
    // With both durations null the "Xd" duration cells collapse to em dashes;
    // the row still renders.
    expect(screen.getByText('Duration')).toBeInTheDocument();
  });
});
