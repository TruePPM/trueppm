import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { TeamHealthPulse } from './TeamHealthPulse';
import type { PulseTrendPoint } from '@/hooks/useRetroBoard';

interface QueryResult<T> {
  data: T;
  isLoading: boolean;
}

interface MutateVars {
  mood: number;
  energy: number;
  confidence: number | null;
}
interface MutateOpts {
  onSuccess?: () => void;
}

const usePulseMock = vi.fn<() => QueryResult<unknown>>();
const usePulseTrendMock = vi.fn<() => QueryResult<unknown>>();
const upsertMutateMock = vi.fn<(vars: MutateVars, opts?: MutateOpts) => void>();
const upsertStateMock = vi.fn<() => { isPending: boolean; isError: boolean }>();

vi.mock('@/hooks/useRetroBoard', () => ({
  usePulse: () => usePulseMock(),
  usePulseTrend: () => usePulseTrendMock(),
  useUpsertPulse: () => ({ mutate: upsertMutateMock, ...upsertStateMock() }),
}));

/** Build a trend point with sane defaults so each test states only what it means. */
function point(over: Partial<PulseTrendPoint> & { sprint_name: string }): PulseTrendPoint {
  return {
    sprint_id: over.sprint_name.toLowerCase(),
    avg_mood: 3,
    avg_energy: 3,
    avg_confidence: 3,
    response_count: 4,
    ...over,
  };
}

beforeEach(() => {
  upsertMutateMock.mockReset();
  upsertStateMock.mockReturnValue({ isPending: false, isError: false });
  usePulseMock.mockReturnValue({ data: null, isLoading: false });
});

describe('TeamHealthPulse — privacy gate (the #923 🔴)', () => {
  it('shows ONLY the "kept private" wall when the trend is gated — no count, no poll, no teaser', () => {
    usePulseTrendMock.mockReturnValue({ data: { gated: true }, isLoading: false });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond={false} />);

    expect(screen.getByText(/keeps its health pulse private/i)).toBeInTheDocument();
    expect(screen.getByText(/shared with the team and their coach only/i)).toBeInTheDocument();
    // The gated reader must see NOTHING else — no poll, no trend, no response count.
    expect(screen.queryByRole('radiogroup', { name: /Mood/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/responded this sprint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Energy down/i)).not.toBeInTheDocument();
  });

  it('renders the poll + trend for the team band (gated:false)', () => {
    usePulseTrendMock.mockReturnValue({
      data: {
        gated: false,
        energy_declining: true,
        points: [
          { sprint_id: 's0', sprint_name: 'S0', avg_mood: 4, avg_energy: 5, avg_confidence: 3, response_count: 5 },
          { sprint_id: 's1', sprint_name: 'S1', avg_mood: 3, avg_energy: 2, avg_confidence: 3, response_count: 6 },
        ],
      },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByRole('radiogroup', { name: /^Mood$/i })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /Energy/i })).toBeInTheDocument();
    // The team (not the PM) sees the aggregate trend + the early-warning flag.
    expect(screen.getByText(/Energy down 2 sprints running/i)).toBeInTheDocument();
    expect(screen.getByText(/6 responded this sprint/i)).toBeInTheDocument();
  });
});

describe('TeamHealthPulse — one-tap poll (#923)', () => {
  beforeEach(() => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
  });

  it('submits mood + energy on tap (one tap per dimension, no submit button)', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const energy = screen.getByRole('radiogroup', { name: /Energy/i });

    // Mood alone does not submit (energy still missing).
    await userEvent.click(within(mood).getAllByRole('radio')[3]); // mood 4
    expect(upsertMutateMock).not.toHaveBeenCalled();

    // Energy completes the required pair → submits mood:4, energy:2.
    await userEvent.click(within(energy).getAllByRole('radio')[1]); // energy 2
    expect(upsertMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ mood: 4, energy: 2 }),
      expect.anything(),
    );

    // There is no submit button — the pulse is one-tap.
    expect(screen.queryByRole('button', { name: /save|submit/i })).not.toBeInTheDocument();
  });

  it('arrow keys move focus across options WITHOUT submitting (no aggregate pollution)', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const options = within(mood).getAllByRole('radio');

    options[0].focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}'); // scan toward 4
    // Scanning must NOT record throwaway answers into the team pulse aggregate.
    expect(upsertMutateMock).not.toHaveBeenCalled();
    // Focus moved (roving tabindex): the third option is now the tabbable one.
    expect(options[3]).toHaveFocus();

    // Activation (Enter on the focused option) is what commits.
    await userEvent.keyboard('{Enter}');
    expect(upsertMutateMock).not.toHaveBeenCalled(); // mood alone — energy still missing
    expect(options[3]).toHaveAttribute('aria-checked', 'true');
  });

  it('disables the poll when the sprint cannot be responded to (CANCELLED)', () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond={false} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    radios.forEach((r) => expect(r).toBeDisabled());
  });
});

describe('TeamHealthPulse — read states', () => {
  it('shows a placeholder and nothing else while the trend is loading', () => {
    usePulseTrendMock.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.queryByRole('heading', { name: /team health/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText(/keeps its health pulse private/i)).not.toBeInTheDocument();
  });

  it('still renders the poll when the trend read resolved with no payload', () => {
    // Neither loading nor gated nor populated — the poll must not vanish.
    usePulseTrendMock.mockReturnValue({ data: undefined, isLoading: false });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByRole('heading', { name: /team health/i })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /^Mood$/i })).toBeInTheDocument();
    expect(screen.queryByText(/responded this sprint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No pulse history yet/i)).not.toBeInTheDocument();
  });

  it('invites the first answer when the team has no history yet', () => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByText(/No pulse history yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/responded this sprint/i)).not.toBeInTheDocument();
    // No early-warning flag when energy is not declining.
    expect(screen.queryByText(/Energy down/i)).not.toBeInTheDocument();
  });
});

describe('TeamHealthPulse — hydrating my own stored answer', () => {
  beforeEach(() => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
  });

  it('pre-selects my stored response once the read resolves — without re-submitting it', () => {
    usePulseMock.mockReturnValue({ data: undefined, isLoading: true });
    const { rerender } = renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    // In flight: nothing is claimed to be selected yet.
    within(screen.getByRole('radiogroup', { name: /^Mood$/i }))
      .getAllByRole('radio')
      .forEach((r) => expect(r).toHaveAttribute('aria-checked', 'false'));

    usePulseMock.mockReturnValue({
      data: { mood: 2, energy: 4, confidence: 5 },
      isLoading: false,
    });
    rerender(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const mood = within(screen.getByRole('radiogroup', { name: /^Mood$/i })).getAllByRole('radio');
    const energy = within(screen.getByRole('radiogroup', { name: /Energy/i })).getAllByRole('radio');
    const conf = within(screen.getByRole('radiogroup', { name: /Confidence/i })).getAllByRole(
      'radio',
    );
    expect(mood[1]).toHaveAttribute('aria-checked', 'true');
    expect(energy[3]).toHaveAttribute('aria-checked', 'true');
    expect(conf[4]).toHaveAttribute('aria-checked', 'true');
    // Hydration is a read — it must never write the answer back.
    expect(upsertMutateMock).not.toHaveBeenCalled();
    // A complete answer means the "pick mood and energy" nudge is gone.
    expect(screen.queryByText(/Pick mood and energy/i)).not.toBeInTheDocument();
  });

  it('hydrates once — a later refetch does not clobber what I just picked', async () => {
    usePulseMock.mockReturnValue({ data: null, isLoading: false });
    const { rerender } = renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    await userEvent.click(within(mood).getAllByRole('radio')[0]); // mood 1

    usePulseMock.mockReturnValue({
      data: { mood: 5, energy: 5, confidence: 5 },
      isLoading: false,
    });
    rerender(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const after = within(screen.getByRole('radiogroup', { name: /^Mood$/i })).getAllByRole('radio');
    expect(after[0]).toHaveAttribute('aria-checked', 'true');
    expect(after[4]).toHaveAttribute('aria-checked', 'false');
  });
});

describe('TeamHealthPulse — status line under the poll', () => {
  beforeEach(() => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('nudges for the required pair only while it is incomplete and answerable', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    expect(screen.getByText(/Pick mood and energy to record your pulse/i)).toBeInTheDocument();

    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    await userEvent.click(within(mood).getAllByRole('radio')[2]);
    // Mood alone is still incomplete — the nudge stays.
    expect(screen.getByText(/Pick mood and energy to record your pulse/i)).toBeInTheDocument();
  });

  it('does not nudge a reader who cannot respond', () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond={false} />);
    expect(screen.queryByText(/Pick mood and energy/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tells me to tap again when the write failed, and hides the nudge', () => {
    upsertStateMock.mockReturnValue({ isPending: false, isError: true });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't record your pulse/i);
    expect(screen.queryByText(/Pick mood and energy/i)).not.toBeInTheDocument();
  });

  it('confirms the save, then clears the confirmation on its own', () => {
    vi.useFakeTimers();
    upsertMutateMock.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const energy = screen.getByRole('radiogroup', { name: /Energy/i });
    fireEvent.click(within(mood).getAllByRole('radio')[3]);
    fireEvent.click(within(energy).getAllByRole('radio')[1]);

    expect(screen.getByText('saved')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByText('saved')).not.toBeInTheDocument();
  });
});

describe('TeamHealthPulse — submitting', () => {
  beforeEach(() => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
  });

  it('sends confidence along once the required pair is already answered', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const energy = screen.getByRole('radiogroup', { name: /Energy/i });
    const conf = screen.getByRole('radiogroup', { name: /Confidence/i });

    await userEvent.click(within(mood).getAllByRole('radio')[1]); // 2
    await userEvent.click(within(energy).getAllByRole('radio')[2]); // 3
    expect(upsertMutateMock).toHaveBeenLastCalledWith(
      { mood: 2, energy: 3, confidence: null },
      expect.anything(),
    );

    await userEvent.click(within(conf).getAllByRole('radio')[4]); // 5
    expect(upsertMutateMock).toHaveBeenLastCalledWith(
      { mood: 2, energy: 3, confidence: 5 },
      expect.anything(),
    );
  });

  it('does not submit confidence on its own — the required pair still gates it', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const conf = screen.getByRole('radiogroup', { name: /Confidence/i });

    await userEvent.click(within(conf).getAllByRole('radio')[0]);
    expect(upsertMutateMock).not.toHaveBeenCalled();
    // ...but the choice is still shown, so it is not silently lost.
    expect(within(conf).getAllByRole('radio')[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('re-submits the whole answer when one dimension is changed', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const mood = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const energy = screen.getByRole('radiogroup', { name: /Energy/i });

    await userEvent.click(within(mood).getAllByRole('radio')[0]);
    await userEvent.click(within(energy).getAllByRole('radio')[0]);
    await userEvent.click(within(mood).getAllByRole('radio')[4]);

    expect(upsertMutateMock).toHaveBeenLastCalledWith(
      { mood: 5, energy: 1, confidence: null },
      expect.anything(),
    );
  });
});

describe('TeamHealthPulse — radiogroup keyboard model', () => {
  beforeEach(() => {
    usePulseTrendMock.mockReturnValue({
      data: { gated: false, energy_declining: false, points: [] },
      isLoading: false,
    });
  });

  it('moves focus backward with ArrowLeft / ArrowUp and stops at the first option', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const options = within(screen.getByRole('radiogroup', { name: /^Mood$/i })).getAllByRole(
      'radio',
    );

    options[0].focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(options[2]).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(options[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    // Clamped at the first option rather than wrapping or escaping the group.
    expect(options[0]).toHaveFocus();
    expect(upsertMutateMock).not.toHaveBeenCalled();
  });

  it('stops at the last option instead of wrapping', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const options = within(screen.getByRole('radiogroup', { name: /Energy/i })).getAllByRole(
      'radio',
    );

    options[0].focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(options[4]).toHaveFocus();
    expect(options[4]).toHaveAttribute('tabindex', '0');
    expect(options[0]).toHaveAttribute('tabindex', '-1');
  });

  it('leaves other keys alone so typing does not hijack the group', async () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    const options = within(screen.getByRole('radiogroup', { name: /^Mood$/i })).getAllByRole(
      'radio',
    );

    options[0].focus();
    await userEvent.keyboard('x{Home}{End}');
    expect(options[0]).toHaveFocus();
    expect(options[0]).toHaveAttribute('tabindex', '0');
  });

  it('ignores arrow keys entirely when the poll is disabled', () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond={false} />);
    const group = screen.getByRole('radiogroup', { name: /^Mood$/i });
    const options = within(group).getAllByRole('radio');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    // The roving index must not move on a group nobody can answer.
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');
  });

  it('parks the roving entry point on my existing answer', () => {
    usePulseMock.mockReturnValue({ data: { mood: 4, energy: 2, confidence: null }, isLoading: false });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const options = within(screen.getByRole('radiogroup', { name: /^Mood$/i })).getAllByRole(
      'radio',
    );
    expect(options[3]).toHaveAttribute('tabindex', '0');
    expect(options[0]).toHaveAttribute('tabindex', '-1');
  });

  it('marks the optional dimension as optional to assistive tech and on screen', () => {
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);
    expect(screen.getByRole('radiogroup', { name: 'Confidence (optional)' })).toBeInTheDocument();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
    // Mood and Energy are required, so they carry no optional marker.
    expect(screen.getByRole('radiogroup', { name: 'Mood' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Energy' })).toBeInTheDocument();
  });
});

describe('TeamHealthPulse — sparklines', () => {
  it('names every sprint and its response count in the accessible description', () => {
    usePulseTrendMock.mockReturnValue({
      data: {
        gated: false,
        energy_declining: false,
        points: [
          point({ sprint_name: 'S1', avg_mood: 3, response_count: 3 }),
          point({ sprint_name: 'S2', avg_mood: 5, response_count: 7 }),
        ],
      },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    const moodChart = screen.getByRole('img', { name: /^Mood trend/ });
    expect(moodChart).toHaveAccessibleName(
      'Mood trend — S1: 3.0 (3 responses); S2: 5.0 (7 responses)',
    );
    expect(screen.getByText(/7 responded this sprint/i)).toBeInTheDocument();
  });

  it('reports a missing sprint as n/a rather than dropping it from the description', () => {
    usePulseTrendMock.mockReturnValue({
      data: {
        gated: false,
        energy_declining: false,
        points: [
          point({ sprint_name: 'S1', avg_mood: 2 }),
          point({ sprint_name: 'S2', avg_mood: null }),
          point({ sprint_name: 'S3', avg_mood: 4, response_count: 9 }),
        ],
      },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByRole('img', { name: /^Mood trend/ })).toHaveAccessibleName(
      /S2: n\/a \(4 responses\)/,
    );
    expect(screen.getByText(/9 responded this sprint/i)).toBeInTheDocument();
  });

  it('says "no data" for a dimension nobody answered instead of drawing an empty chart', () => {
    usePulseTrendMock.mockReturnValue({
      data: {
        gated: false,
        energy_declining: false,
        points: [
          point({ sprint_name: 'S1', avg_confidence: null }),
          point({ sprint_name: 'S2', avg_confidence: null }),
        ],
      },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByText('no data')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^Confidence trend/ })).not.toBeInTheDocument();
    // The dimensions that do have data still chart.
    expect(screen.getByRole('img', { name: /^Mood trend/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Energy trend/ })).toBeInTheDocument();
  });

  it('charts a single sprint without dividing by a zero span', () => {
    usePulseTrendMock.mockReturnValue({
      data: {
        gated: false,
        energy_declining: false,
        points: [point({ sprint_name: 'Only', avg_mood: 5, response_count: 1 })],
      },
      isLoading: false,
    });
    renderWithProviders(<TeamHealthPulse sprintId="sp-1" canRespond />);

    expect(screen.getByRole('img', { name: /^Mood trend/ })).toHaveAccessibleName(
      'Mood trend — Only: 5.0 (1 responses)',
    );
    expect(screen.getByText(/1 responded this sprint/i)).toBeInTheDocument();
  });
});
