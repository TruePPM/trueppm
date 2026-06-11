import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { TeamHealthPulse } from './TeamHealthPulse';

interface QueryResult<T> {
  data: T;
  isLoading: boolean;
}

const usePulseMock = vi.fn<() => QueryResult<unknown>>();
const usePulseTrendMock = vi.fn<() => QueryResult<unknown>>();
const upsertMutateMock = vi.fn();

vi.mock('@/hooks/useRetroBoard', () => ({
  usePulse: () => usePulseMock(),
  usePulseTrend: () => usePulseTrendMock(),
  useUpsertPulse: () => ({ mutate: upsertMutateMock, isPending: false, isError: false }),
}));

beforeEach(() => {
  upsertMutateMock.mockReset();
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
