import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { PromoteMilestoneDialog } from './PromoteMilestoneDialog';
import type { ApiSprint } from '@/types';
import type { MilestoneCandidate, ReforecastPreview } from '@/hooks/usePromoteMilestone';

// Hoisted mock state so the vi.mock factory can close over it.
const h = vi.hoisted(() => ({
  promoteMutate: vi.fn(),
  unbindMutate: vi.fn(),
  promote: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  unbind: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  candidates: [] as MilestoneCandidate[],
  preview: null as ReforecastPreview | null,
}));

vi.mock('@/hooks/usePromoteMilestone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/usePromoteMilestone')>();
  return {
    ...actual, // keep real isSprintAlreadyBound / SPRINT_ALREADY_BOUND
    usePromoteSprintToMilestone: () => ({ ...h.promote, mutate: h.promoteMutate }),
    useUnbindSprintMilestone: () => ({ ...h.unbind, mutate: h.unbindMutate }),
    useMilestoneCandidates: () => ({ candidates: h.candidates, isLoading: false }),
    useReforecastPreview: () => ({ preview: h.preview, isLoading: false }),
  };
});

function makeSprint(overrides: Partial<ApiSprint> = {}): ApiSprint {
  return {
    id: 'sp-1',
    server_version: 1,
    short_id: 'A1B2',
    short_id_display: 'SP-12',
    name: 'Sprint 12',
    goal: 'Close out telemetry FAT prep',
    notes: '',
    start_date: '2026-06-16',
    finish_date: '2026-06-27',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: 34,
    wip_limit: null,
    committed_points: 34,
    committed_task_count: 8,
    completed_points: 10,
    completed_task_count: 3,
    completion_ratio_points: 0.29,
    completion_ratio_tasks: 0.38,
    activated_at: '2026-06-16T09:00:00Z',
    closed_at: null,
    created_at: '2026-06-10T09:00:00Z',
    updated_at: '2026-06-20T09:00:00Z',
    ...overrides,
  };
}

const CANDIDATES: MilestoneCandidate[] = [
  { id: 'm-fat', name: 'FAT review', wbs: '1.3.1', finish: '2026-07-18', isBound: false },
  { id: 'm-p3', name: 'Phase-3 handoff', wbs: '1.4.0', finish: '2026-08-02', isBound: true },
];

const PREVIEW: ReforecastPreview = {
  basis: 'velocity_band',
  cpmFinish: '2026-07-18',
  p50: '2026-07-14',
  p80: '2026-07-16',
  p95: '2026-07-19',
  teamPaceLow: 21,
  teamPaceHigh: 27,
  unmodeledDependency: false,
};

beforeEach(() => {
  h.promoteMutate.mockReset();
  h.unbindMutate.mockReset();
  h.promote.isPending = false;
  h.promote.isError = false;
  h.promote.error = null;
  h.unbind.isPending = false;
  h.unbind.isError = false;
  h.candidates = [...CANDIDATES];
  h.preview = PREVIEW;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('PromoteMilestoneDialog', () => {
  it('opens in create mode with the name + target date prefilled and editable', () => {
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: /Promote sprint to milestone/i });
    expect(dialog).toBeInTheDocument();
    // create mode prefills editable inputs with the goal-derived name + sprint finish
    expect(within(dialog).getByDisplayValue('Close out telemetry FAT prep')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('2026-06-27')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create & bind/i })).toBeInTheDocument();
  });

  it('create-mode passes the edited name and target date to the mutation', async () => {
    h.promoteMutate.mockImplementation(
      (_p: unknown, opts?: { onSuccess?: (s: ApiSprint) => void }) =>
        opts?.onSuccess?.(makeSprint({ target_milestone: 'm-new' })),
    );
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    const nameInput = screen.getByDisplayValue('Close out telemetry FAT prep');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Customer Beta Gate');
    // date inputs don't take userEvent.type reliably — set the value directly.
    fireEvent.change(screen.getByDisplayValue('2026-06-27'), {
      target: { value: '2026-07-30' },
    });
    await userEvent.click(screen.getByRole('button', { name: /Create & bind/i }));
    expect(h.promoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sprintId: 'sp-1',
        milestoneId: null,
        name: 'Customer Beta Gate',
        targetDate: '2026-07-30',
      }),
      expect.anything(),
    );
  });

  it('create-mode submit promotes with no milestone id (create+bind)', async () => {
    const onClose = vi.fn();
    h.promoteMutate.mockImplementation(
      (_p: unknown, opts?: { onSuccess?: (s: ApiSprint) => void }) =>
        opts?.onSuccess?.(makeSprint({ target_milestone: 'm-new' })),
    );
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Create & bind/i }));
    expect(h.promoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sprintId: 'sp-1', milestoneId: null }),
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('bind mode lists candidates and submits the selected milestone id', async () => {
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Bind existing/i }));
    // The primary stays disabled until a milestone is chosen.
    expect(screen.getByRole('button', { name: /Bind & reforecast/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /FAT review/i }));
    const submit = screen.getByRole('button', { name: /Bind & reforecast/i });
    expect(submit).not.toBeDisabled();
    await userEvent.click(submit);
    expect(h.promoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sprintId: 'sp-1', milestoneId: 'm-fat' }),
      expect.anything(),
    );
  });

  it('renders the live reforecast preview (variant B showpiece)', () => {
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/CPM finish · projected/i)).toBeInTheDocument();
    expect(screen.getByText(/CPM-only \(today\)/i)).toBeInTheDocument();
    // P80 pull-in is shown with a signed day delta
    expect(screen.getByText(/With this sprint/i)).toBeInTheDocument();
    expect(screen.getByText('-2d')).toBeInTheDocument();
    // velocity is framed as "team pace", never a raw management gauge
    expect(screen.getByText(/Team pace/i)).toBeInTheDocument();
    // #1094: a velocity_band preview is labeled honestly — no P50/P95 percentile
    // vocabulary, and a visible "not simulated" qualifier.
    expect(screen.getByText(/Estimate — velocity-based, not simulated/i)).toBeInTheDocument();
    expect(screen.queryByText('P50', { exact: false })).toBeNull();
    // "Likely" labels both the on-bar marker and the footer tick.
    expect(screen.getAllByText(/Likely/).length).toBeGreaterThan(0);
  });

  it('quick mode collapses to the compact (variant A) layout, hiding the preview', async () => {
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/CPM finish · projected/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Quick mode/i }));
    expect(screen.queryByText(/CPM finish · projected/i)).not.toBeInTheDocument();
  });

  it('compact prop forces variant A from the start', () => {
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} compact />,
    );
    expect(screen.queryByText(/CPM finish · projected/i)).not.toBeInTheDocument();
  });

  it('an already-bound sprint opens the 409 conflict view', () => {
    const sprint = makeSprint({
      target_milestone: 'm-fat',
      target_milestone_detail: { id: 'm-fat', name: 'FAT review', wbs_path: '1.3.1', finish: '2026-07-18' },
    });
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={sprint} onClose={vi.fn()} />,
    );
    expect(
      screen.getByRole('dialog', { name: /already bound to a milestone/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep current binding/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Unbind$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rebind to another/i })).toBeInTheDocument();
  });

  it('unbind from the conflict view calls the unbind mutation', async () => {
    const sprint = makeSprint({
      target_milestone: 'm-fat',
      target_milestone_detail: { id: 'm-fat', name: 'FAT review', wbs_path: '1.3.1', finish: '2026-07-18' },
    });
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={sprint} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Unbind$/i }));
    expect(h.unbindMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sprintId: 'sp-1' }),
      expect.anything(),
    );
  });

  it('rebind from the conflict view reveals the promote form', async () => {
    const sprint = makeSprint({
      target_milestone: 'm-fat',
      target_milestone_detail: { id: 'm-fat', name: 'FAT review', wbs_path: '1.3.1', finish: '2026-07-18' },
    });
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={sprint} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Rebind to another/i }));
    expect(screen.getByRole('group', { name: /Milestone source/i })).toBeInTheDocument();
    // A rebind warns it will move the reforecast off the current milestone.
    expect(screen.getByText(/Rebinding moves the reforecast/i)).toBeInTheDocument();
  });

  it('a 409 sprint_already_bound race flips the form into the conflict view', async () => {
    h.promoteMutate.mockImplementation(
      (_p: unknown, opts?: { onError?: (e: unknown) => void }) =>
        opts?.onError?.({ response: { status: 409, data: { code: 'sprint_already_bound' } } }),
    );
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Create & bind/i }));
    expect(
      await screen.findByRole('dialog', { name: /already bound to a milestone/i }),
    ).toBeInTheDocument();
  });

  it('disables the bind action when offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Create & bind/i })).toBeDisabled();
  });

  it('closes on Cancel and on Escape', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <PromoteMilestoneDialog projectId="proj-1" sprint={makeSprint()} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
