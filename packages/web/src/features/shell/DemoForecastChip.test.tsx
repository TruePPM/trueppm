import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { DemoForecastChip } from './DemoForecastChip';
import type { MonteCarloResult } from '@/types';

const state = vi.hoisted(() => ({
  projectId: 'p1' as string | undefined,
  result: undefined as Partial<MonteCarloResult> | undefined,
  tasks: [{ id: 't1' }, { id: 't2' }] as unknown[] | undefined,
}));
const triggerRef = vi.hoisted(() => ({ current: null as HTMLButtonElement | null }));
const popoverRef = vi.hoisted(() => ({ current: null as HTMLDivElement | null }));

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => state.projectId }));
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({ data: state.result, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: state.tasks }),
}));
vi.mock('@/hooks/useAnchoredPopover', () => ({
  useAnchoredPopover: (opts: { open: boolean }) => ({
    triggerRef,
    popoverRef,
    popoverStyle: opts.open ? { position: 'fixed', top: 40, left: 8, width: 520 } : null,
    reposition: vi.fn(),
  }),
}));
vi.mock('@/features/schedule/ScheduleForecastBar', () => ({
  ScheduleForecastBar: (props: { variant: string; tasks: unknown[]; cpmFinish: string | null }) => (
    <div
      data-testid="forecast-bar"
      data-variant={props.variant}
      data-tasks={props.tasks.length}
      data-target={props.cpmFinish ?? ''}
    />
  ),
}));

function renderChip(path = '/projects/p1/schedule') {
  return renderWithProvidersAndRouter(<DemoForecastChip />, { initialEntries: [path] });
}

beforeEach(() => {
  state.projectId = 'p1';
  state.result = { p80: '2026-09-18', cpmFinish: '2026-09-04' };
  state.tasks = [{ id: 't1' }, { id: 't2' }];
  triggerRef.current = null;
  popoverRef.current = null;
});

describe('DemoForecastChip', () => {
  it('renders nothing off the schedule route or without a project', () => {
    const { container } = renderChip('/projects/p1/board');
    expect(container).toBeEmptyDOMElement();

    state.projectId = undefined;
    const { container: noProject } = renderChip();
    expect(noProject).toBeEmptyDOMElement();
  });

  it('renders nothing before the first Monte Carlo run', () => {
    state.result = undefined;
    const { container } = renderChip();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the P80 headline and the CPM target on the chip', () => {
    renderChip();
    const chip = screen.getByTestId('demo-forecast-chip');
    expect(chip).toHaveTextContent(/Forecast/);
    expect(chip).toHaveTextContent(/P80 Sep 18/);
    expect(chip).toHaveTextContent(/target Sep 4/);
    expect(chip).not.toHaveTextContent(/P50|P95/);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('omits the target when the server has no CPM finish', () => {
    state.result = { p80: '2026-09-18', cpmFinish: null };
    renderChip();
    expect(screen.getByTestId('demo-forecast-chip')).not.toHaveTextContent(/target/);
  });

  it('opens the real forecast bar in a popover on click and closes on a second click', async () => {
    const user = userEvent.setup();
    renderChip();
    const chip = screen.getByTestId('demo-forecast-chip');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Schedule forecast' });
    expect(dialog).toHaveStyle({ position: 'fixed' });
    const bar = screen.getByTestId('forecast-bar');
    expect(bar).toHaveAttribute('data-variant', 'popover');
    expect(bar).toHaveAttribute('data-tasks', '2');
    expect(bar).toHaveAttribute('data-target', '2026-09-04');

    await user.click(chip);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('passes an empty task list to the bar while tasks are still loading', async () => {
    const user = userEvent.setup();
    state.tasks = undefined;
    renderChip();
    await user.click(screen.getByTestId('demo-forecast-chip'));
    expect(screen.getByTestId('forecast-bar')).toHaveAttribute('data-tasks', '0');
  });

  it('Escape closes the popover and returns focus to the chip; other keys are ignored', async () => {
    const user = userEvent.setup();
    renderChip();
    const chip = screen.getByTestId('demo-forecast-chip');
    await user.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(chip);
  });
});
