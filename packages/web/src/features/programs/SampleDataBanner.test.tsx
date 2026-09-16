import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SampleDataBanner } from './SampleDataBanner';

const removeMutate = vi.fn();
const shiftMutate = vi.fn();
let shiftState = { isPending: false, isError: false };
let removeState = { isPending: false, isError: false };

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useRemoveSampleProgram: () => ({ mutate: removeMutate, ...removeState }),
  useShiftSampleDates: () => ({ mutate: shiftMutate, ...shiftState }),
}));

interface Options {
  canRemove?: boolean;
  sampleDaysStale?: number | null;
}

function renderBanner({ canRemove = true, sampleDaysStale = 0 }: Options = {}) {
  return render(
    <MemoryRouter>
      <SampleDataBanner
        programId="prog-1"
        canRemove={canRemove}
        sampleDaysStale={sampleDaysStale}
      />
    </MemoryRouter>,
  );
}

const shiftTrigger = () => screen.queryByRole('button', { name: /shift dates to today/i });

beforeEach(() => {
  removeMutate.mockReset();
  shiftMutate.mockReset();
  shiftState = { isPending: false, isError: false };
  removeState = { isPending: false, isError: false };
});

describe('SampleDataBanner — teardown (existing behaviour)', () => {
  it('warns that the user own changes are also deleted before teardown (#1053)', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /remove sample data/i }));
    expect(screen.getByText(/including any changes you made/i)).toBeInTheDocument();
    expect(screen.getByText(/your own projects are not affected/i)).toBeInTheDocument();
  });

  it('advertises the 60 days of bundled history while the demo is current (#376)', () => {
    renderBanner();
    expect(screen.getByText(/includes 60 days of history/i)).toBeInTheDocument();
  });

  it('hides the teardown control when the user cannot remove', () => {
    renderBanner({ canRemove: false });
    expect(screen.queryByRole('button', { name: /remove sample data/i })).not.toBeInTheDocument();
  });
});

describe('SampleDataBanner — date drift (#3481)', () => {
  it('stops claiming the history renders out of the box once the demo is stale', () => {
    // The whole defect: at seven weeks that sentence is false. It must be
    // REPLACED, not merely supplemented with a warning beside it.
    renderBanner({ sampleDaysStale: 47 });
    expect(screen.queryByText(/render out of the box/i)).not.toBeInTheDocument();
    expect(screen.getByText(/47 days ago/i)).toBeInTheDocument();
    expect(screen.getByText(/drifted from today/i)).toBeInTheDocument();
  });

  it('keeps the original promise while the demo is genuinely current', () => {
    renderBanner({ sampleDaysStale: 3 });
    expect(screen.getByText(/includes 60 days of history/i)).toBeInTheDocument();
    expect(screen.queryByText(/drifted from today/i)).not.toBeInTheDocument();
  });

  it('withholds the shift control below the one-week quantum', () => {
    // The server rounds the offset to whole weeks, so under 7 days it would
    // compute zero. Offering the control would be offering a no-op.
    renderBanner({ sampleDaysStale: 6 });
    expect(shiftTrigger()).not.toBeInTheDocument();
  });

  it('offers the shift once a full week has drifted', () => {
    renderBanner({ sampleDaysStale: 7 });
    expect(shiftTrigger()).toBeInTheDocument();
  });

  it('never offers the shift to a non-owner', () => {
    renderBanner({ canRemove: false, sampleDaysStale: 47 });
    expect(shiftTrigger()).not.toBeInTheDocument();
  });

  it('confirms before shifting, and says edits move but nothing is deleted', () => {
    // The clause that separates this from the destructive control 8px away.
    renderBanner({ sampleDaysStale: 47 });
    fireEvent.click(shiftTrigger()!);

    expect(screen.getByText(/moves every date in the demo forward 47 days/i)).toBeInTheDocument();
    expect(screen.getByText(/including any changes you made/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
    expect(shiftMutate).not.toHaveBeenCalled();
  });

  it('sends the mutation only after the confirm step', () => {
    renderBanner({ sampleDaysStale: 47 });
    fireEvent.click(shiftTrigger()!);
    fireEvent.click(screen.getByRole('button', { name: /^shift dates$/i }));
    expect(shiftMutate).toHaveBeenCalledWith('prog-1', expect.anything());
  });

  it('reports how far the dates moved and how much changed', () => {
    // "When this date moves, can I show why?" — a bulk move that reports nothing
    // cannot be defended afterwards.
    shiftMutate.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({
        shifted: true,
        days: 49,
        anchor_date: '2026-09-15',
        rows_shifted: 1284,
        projects: 3,
      }),
    );
    renderBanner({ sampleDaysStale: 47 });
    fireEvent.click(shiftTrigger()!);
    fireEvent.click(screen.getByRole('button', { name: /^shift dates$/i }));

    expect(screen.getByText(/dates updated/i)).toBeInTheDocument();
    expect(screen.getByText(/forward 49 days/i)).toBeInTheDocument();
    expect(screen.getByText(/1,284 records across 3 projects/i)).toBeInTheDocument();
    expect(screen.getByText(/schedules are recalculating/i)).toBeInTheDocument();
  });

  it('says "already current" when the server reports nothing to move', () => {
    // shifted:false arrives with a 200 — idempotent, not a failure.
    shiftMutate.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({
        shifted: false,
        days: 0,
        anchor_date: '2026-09-15',
        rows_shifted: 0,
        projects: 3,
      }),
    );
    renderBanner({ sampleDaysStale: 47 });
    fireEvent.click(shiftTrigger()!);
    fireEvent.click(screen.getByRole('button', { name: /^shift dates$/i }));

    expect(screen.getByText(/already current/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides Cancel while the write is in flight', () => {
    // A bulk write cannot be cancelled; a Cancel that does nothing is a lie.
    shiftState = { isPending: true, isError: false };
    renderBanner({ sampleDaysStale: 47 });
    fireEvent.click(shiftTrigger()!);

    expect(screen.getByRole('button', { name: /shifting dates/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('surfaces a failure as an alert without claiming anything moved', () => {
    shiftState = { isPending: false, isError: true };
    renderBanner({ sampleDaysStale: 47 });

    expect(screen.getByRole('alert')).toHaveTextContent(/could not shift the demo dates/i);
    expect(screen.queryByText(/dates updated/i)).not.toBeInTheDocument();
  });

  it('tells the owner to reload a sample that carries no anchor', () => {
    // Loaded before #3481 — the server would refuse, so no control is offered.
    renderBanner({ sampleDaysStale: null });
    expect(shiftTrigger()).not.toBeInTheDocument();
    expect(screen.getByText(/remove and reload it to get current dates/i)).toBeInTheDocument();
  });

  it('does not show the reload note to a non-owner, who can act on neither', () => {
    renderBanner({ canRemove: false, sampleDaysStale: null });
    expect(
      screen.queryByText(/remove and reload it to get current dates/i),
    ).not.toBeInTheDocument();
  });
});
