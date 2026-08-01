/**
 * Unit tests for AllocationEditPopover (issue #85, ADR-0031).
 *
 * Drives every guard in the popover: the 1–200 validity window, the pre-save
 * overallocation warning, the Escape / Enter keyboard contract, the Tab focus
 * trap in both directions, the unscheduled date-range fallback, and the
 * success / failure / pending outcomes of the PATCH.
 */
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { AllocationEditPopover } from './AllocationEditPopover';
import type { AllocationTask } from './resourceUtils';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

function makeTask(overrides: Partial<AllocationTask> = {}): AllocationTask {
  return {
    assignment_id: 'assign-1',
    id: 'task-1',
    name: 'Draft SOW',
    early_start: '2026-04-01',
    early_finish: '2026-04-10',
    // Not-started/complete windows coincide (ADR-0752 §2); most tests below
    // don't care about the in-progress-narrowing distinction.
    scheduled_start: '2026-04-01',
    units: '0.50',
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

interface RenderOpts {
  task?: Partial<AllocationTask>;
  maxUnits?: number;
  onClose?: () => void;
  onSaved?: (assignmentId: string, newUnits: number) => void;
  projectId?: string | undefined;
}

function renderPopover(opts: RenderOpts = {}) {
  const onClose = opts.onClose ?? vi.fn();
  const onSaved = opts.onSaved ?? vi.fn<(assignmentId: string, newUnits: number) => void>();
  const result = renderWithProviders(
    <AllocationEditPopover
      assignmentId="assign-1"
      task={makeTask(opts.task)}
      resourceName="Anna Khoury"
      maxUnits={opts.maxUnits ?? 1}
      onClose={onClose}
      onSaved={onSaved}
      projectId={'projectId' in opts ? opts.projectId : 'proj-1'}
    />,
  );
  return { ...result, onClose, onSaved };
}

function allocationInput() {
  return screen.getByLabelText<HTMLInputElement>('Allocation');
}

beforeEach(() => {
  patchMock.mockReset().mockResolvedValue({ data: {} });
});

describe('AllocationEditPopover — initial render', () => {
  it('seeds the input from the decimal units and labels the dialog with the task', () => {
    renderPopover();
    expect(allocationInput().value).toBe('50');
    expect(
      screen.getByRole('dialog', { name: 'Edit allocation for Draft SOW' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Draft SOW')).toBeInTheDocument();
  });

  it('shows the resource name and the task date range', () => {
    renderPopover();
    expect(screen.getByText('Anna Khoury · 2026-04-01 – 2026-04-10')).toBeInTheDocument();
  });

  it('falls back to "Unscheduled" when the task has no CPM finish date', () => {
    renderPopover({ task: { early_finish: null } });
    expect(screen.getByText('Anna Khoury · Unscheduled')).toBeInTheDocument();
  });

  it('falls back to "Unscheduled" when the task has no CPM start date', () => {
    renderPopover({ task: { early_start: null, scheduled_start: null } });
    expect(screen.getByText('Anna Khoury · Unscheduled')).toBeInTheDocument();
  });

  it('renders the SPAN start (scheduled_start), not the narrowed early_start, for an in-progress task (#2677)', () => {
    // early_start has narrowed to the remaining-work window; scheduled_start
    // (ADR-0752) still carries the real span start.
    renderPopover({
      task: {
        early_start: '2026-04-08',
        scheduled_start: '2026-04-01',
        early_finish: '2026-04-10',
      },
    });
    expect(screen.getByText('Anna Khoury · 2026-04-01 – 2026-04-10')).toBeInTheDocument();
  });

  it('falls back to early_start when scheduled_start is null (not yet recalculated)', () => {
    renderPopover({ task: { early_start: '2026-04-01', scheduled_start: null } });
    expect(screen.getByText('Anna Khoury · 2026-04-01 – 2026-04-10')).toBeInTheDocument();
  });

  it('focuses the allocation input on mount', () => {
    renderPopover();
    expect(document.activeElement).toBe(allocationInput());
  });
});

describe('AllocationEditPopover — validity window (1–200)', () => {
  it('accepts a value inside the window: no error message, Save enabled', () => {
    renderPopover();
    expect(screen.queryByText('Enter a value between 1 and 200.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(allocationInput().className).toContain('border-neutral-border');
  });

  it('rejects a value above 200 with an inline message and a critical border', async () => {
    const user = userEvent.setup();
    renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '201');

    expect(screen.getByText('Enter a value between 1 and 200.')).toBeInTheDocument();
    expect(input.className).toContain('border-semantic-critical');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('rejects a value below 1', async () => {
    const user = userEvent.setup();
    renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '0');

    expect(screen.getByText('Enter a value between 1 and 200.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('accepts exactly 1 and exactly 200 (inclusive bounds)', async () => {
    const user = userEvent.setup();
    renderPopover();
    const input = allocationInput();

    await user.clear(input);
    await user.type(input, '1');
    expect(screen.queryByText('Enter a value between 1 and 200.')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '200');
    expect(screen.queryByText('Enter a value between 1 and 200.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('an emptied field is invalid but shows no error message yet (nothing typed)', async () => {
    const user = userEvent.setup();
    renderPopover();
    const input = allocationInput();
    await user.clear(input);

    expect(input.value).toBe('');
    expect(screen.queryByText('Enter a value between 1 and 200.')).not.toBeInTheDocument();
    expect(input.className).toContain('border-neutral-border');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('AllocationEditPopover — pre-save overallocation warning', () => {
  it('warns when the new value alone exceeds the resource max_units', async () => {
    const user = userEvent.setup();
    renderPopover({ maxUnits: 1 });
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '150');

    expect(screen.getByText('150% exceeds 100% availability.')).toBeInTheDocument();
  });

  it('renders the warning against a part-time max_units', async () => {
    const user = userEvent.setup();
    renderPopover({ maxUnits: 0.5 });
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '80');

    expect(screen.getByText('80% exceeds 50% availability.')).toBeInTheDocument();
  });

  it('does not warn when the new value is within max_units', async () => {
    const user = userEvent.setup();
    renderPopover({ maxUnits: 1 });
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '100');

    expect(screen.queryByText(/exceeds/)).not.toBeInTheDocument();
  });

  it('does not warn while the value is invalid (no units to compare)', async () => {
    const user = userEvent.setup();
    renderPopover({ maxUnits: 0.5 });
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '900');

    expect(screen.queryByText(/exceeds/)).not.toBeInTheDocument();
    expect(screen.getByText('Enter a value between 1 and 200.')).toBeInTheDocument();
  });
});

describe('AllocationEditPopover — saving', () => {
  it('PATCHes the assignment, notifies the parent, and closes on success', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved } = renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '75');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('assign-1', 0.75));
    expect(patchMock).toHaveBeenCalledWith('/task-resources/assign-1/', { units: 0.75 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves on Enter from the input', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '120{Enter}');

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('assign-1', 1.2));
  });

  it('ignores Enter while the value is out of range', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '400{Enter}');

    expect(patchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a non-Enter key in the input', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.type(allocationInput(), '{ArrowUp}');
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('surfaces a retryable message and keeps the popover open when the PATCH fails', async () => {
    patchMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    const { onClose, onSaved } = renderPopover();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Save failed — please try again.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a pending label and disables Save while the PATCH is in flight', async () => {
    patchMock.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
  });

  it('closes without saving from Cancel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPopover();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe('AllocationEditPopover — keyboard contract', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPopover();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on an unrelated key', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPopover();
    await user.keyboard('{Shift}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once unmounted', async () => {
    const user = userEvent.setup();
    const { onClose, unmount } = renderPopover();
    unmount();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    renderPopover();
    const save = screen.getByRole('button', { name: 'Save changes' });
    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(allocationInput());
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = userEvent.setup();
    renderPopover();
    allocationInput().focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save changes' }));
  });

  it('leaves Tab alone in the middle of the trap', async () => {
    const user = userEvent.setup();
    renderPopover();
    allocationInput().focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('leaves Shift+Tab alone in the middle of the trap', async () => {
    const user = userEvent.setup();
    renderPopover();
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(allocationInput());
  });

  it('excludes a disabled Save button from the trap, wrapping from Cancel instead', async () => {
    const user = userEvent.setup();
    renderPopover();
    const input = allocationInput();
    await user.clear(input);
    await user.type(input, '999');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(allocationInput());
  });
});
