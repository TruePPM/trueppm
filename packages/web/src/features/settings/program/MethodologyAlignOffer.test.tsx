import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MethodologyAlignOffer, alignMatrixHref } from './MethodologyAlignOffer';
import type { Methodology, Project } from '@/types';

const useProgramProjects = vi.fn();
vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () => useProgramProjects() as unknown,
}));

function project(id: string, name: string, methodology: Methodology): Project {
  return {
    id,
    name,
    healthState: 'unknown',
    colorDot: '#3E8C6D',
    methodology,
    effectiveMethodology: methodology,
    programId: 'p-1',
  } as Project;
}

const refetch = vi.fn();
const onAnnounce = vi.fn<(sentence: string) => void>();

function mockQuery(over: Record<string, unknown>) {
  useProgramProjects.mockReturnValue({
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch,
    ...over,
  });
}

function renderOffer(methodology: Methodology = 'WATERFALL') {
  return render(
    <MemoryRouter>
      <MethodologyAlignOffer
        id="offer"
        programId="p-1"
        methodology={methodology}
        onAnnounce={onAnnounce}
      />
    </MemoryRouter>,
  );
}

describe('MethodologyAlignOffer (#3293)', () => {
  beforeEach(() => {
    useProgramProjects.mockReset();
    refetch.mockReset();
    onAnnounce.mockReset();
  });

  // D18 — a committed write must never read as provisional. "Saved." is rendered by
  // every branch, including the one where the partition has not resolved.
  it('says "Saved." before the counts resolve', async () => {
    mockQuery({ isPending: true });
    renderOffer();
    expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(/^Saved\./);
    await waitFor(() =>
      expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(
        /Checking the projects in this program/i,
      ),
    );
  });

  /**
   * Web-rule 335. The panel MOUNTS — often with the roster already in cache from the
   * Projects section of the same consolidated page — so it must NOT carry `role="status"`
   * itself: a region entering the accessibility tree with its text already inside is
   * announced inconsistently or not at all. It announces through the caller's persistent
   * region instead, and keeps the id only so the radiogroup can describe it.
   */
  it('is not a live region itself — it announces through the caller', () => {
    mockQuery({ data: [project('pr-1', 'Artemis IV', 'AGILE')] });
    renderOffer('WATERFALL');
    const panel = screen.getByTestId('methodology-align-offer');
    expect(panel).not.toHaveAttribute('role');
    expect(panel).toHaveAttribute('id', 'offer');
    // "Saved." leads in every state — the write landed, whatever the partition says.
    expect(panel.textContent?.trimStart().startsWith('Saved.')).toBe(true);
  });

  // The spoken sentence is not the visual fragments concatenated: it names the link,
  // which a sighted reader can simply see, and it is a whole sentence.
  it('announces a full sentence naming the next act', async () => {
    mockQuery({
      data: [
        project('pr-1', 'Artemis IV', 'WATERFALL'),
        project('pr-2', 'Launch Control', 'AGILE'),
        project('pr-3', 'Ground Support', 'HYBRID'),
      ],
    });
    renderOffer('WATERFALL');
    await waitFor(() => expect(onAnnounce).toHaveBeenCalled());
    expect(onAnnounce).toHaveBeenLastCalledWith(
      'Saved. 1 of 3 projects in this program run as Waterfall; 2 do not. Existing projects keep their own methodology. Use the Align the 2 link to change them.',
    );
  });

  // "Checking…" is chrome for a state that resolves on its own; announcing it would put
  // a placeholder ahead of the answer on the one channel that cannot be re-read.
  it('announces nothing while the partition is still resolving', () => {
    mockQuery({ isPending: true });
    renderOffer();
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  /**
   * The roster refetch that the program save triggers is in flight when this mounts, and
   * until it lands every row's `inheritedMethodology` still names the PREVIOUS program
   * methodology — which is what the matrix computes its "deviates" cohort from. Offering
   * the link over stale rows sends "Align the 2" to a cohort of a different size.
   */
  it('withholds the link until the roster refetch settles', async () => {
    mockQuery({
      data: [project('pr-1', 'Artemis IV', 'AGILE')],
      isFetching: true,
    });
    const { rerender } = renderOffer('WATERFALL');
    expect(screen.queryByRole('link', { name: /^Align/ })).toBeNull();
    expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(/Checking/i);

    mockQuery({ data: [project('pr-1', 'Artemis IV', 'AGILE')], isFetching: false });
    rerender(
      <MemoryRouter>
        <MethodologyAlignOffer
          id="offer"
          programId="p-1"
          methodology="WATERFALL"
          onAnnounce={onAnnounce}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^Align/ })).toBeInTheDocument(),
    );
  });

  it('reports the partition and links to the matrix when projects differ', async () => {
    mockQuery({
      data: [
        project('pr-1', 'Artemis IV', 'WATERFALL'),
        project('pr-2', 'Launch Control', 'AGILE'),
        project('pr-3', 'Ground Support', 'HYBRID'),
      ],
    });
    renderOffer('WATERFALL');
    const region = await screen.findByTestId('methodology-align-offer');
    await waitFor(() =>
      expect(region).toHaveTextContent(/1 of 3 projects in this program run as Waterfall; 2 do not/i),
    );
    // The vocabulary #3293's hint uses, repeated where the consequence is stated.
    expect(region).toHaveTextContent(/Existing projects keep their own methodology/i);

    // D19 — a link, never a button: it navigates and never writes.
    const link = screen.getByRole('link', { name: 'Align the 2 projects that differ' });
    expect(link).toHaveTextContent('Align the 2');
    expect(link).toHaveAttribute('href', '/programs/p-1/settings?bulk=methodology&only=deviating#projects');
  });

  // At N=1 a count is worse than the name; at N>1 a truncated list of names is worse
  // than a count. Both halves of that ruling live here.
  it('names the single project in the sentence and the link at N=1', async () => {
    mockQuery({
      data: [
        project('pr-1', 'Cascade Migration', 'AGILE'),
        project('pr-2', 'Ground Support', 'WATERFALL'),
      ],
    });
    renderOffer('WATERFALL');
    await waitFor(() =>
      expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(
        /1 of 2 projects in this program run as Waterfall; Cascade Migration does not/i,
      ),
    );
    const link = screen.getByRole('link', {
      name: 'Align Cascade Migration, the project that differs',
    });
    expect(link).toHaveTextContent('Align Cascade Migration');
  });

  // D21 — the matrix caps a single apply at 200 rows. Arriving at "200 of 240 checked"
  // without warning reads as a silent truncation, so the button names the cap.
  it('names the 200-row cap when more than 200 projects differ', async () => {
    mockQuery({
      data: Array.from({ length: 240 }, (_, i) => project(`pr-${i}`, `Project ${i}`, 'AGILE')),
    });
    renderOffer('WATERFALL');
    const link = await screen.findByRole('link', {
      name: 'Align the first 200 of 240 projects that differ',
    });
    expect(link).toHaveTextContent('Align the first 200');
  });

  // D20 — the sentence that licenses "the program is standardized". Without it the
  // all-match case is silence, which is what let Marcus tell his steering committee
  // something the product had never confirmed.
  it('states the all-match case rather than rendering nothing', async () => {
    mockQuery({
      data: [
        project('pr-1', 'Artemis IV', 'WATERFALL'),
        project('pr-2', 'Launch Control', 'WATERFALL'),
      ],
    });
    renderOffer('WATERFALL');
    await waitFor(() =>
      expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(
        /All 2 projects in this program already run as Waterfall/i,
      ),
    );
    expect(screen.queryByRole('link', { name: /^Align/ })).toBeNull();
  });

  it('states the no-projects case', async () => {
    mockQuery({ data: [] });
    renderOffer('AGILE');
    await waitFor(() =>
      expect(screen.getByTestId('methodology-align-offer')).toHaveTextContent(
        /This program has no projects yet/i,
      ),
    );
  });

  /**
   * A failed count must keep the invariant claim and invent nothing. "0 differ" here
   * would be a claim that a check ran; the check is exactly what failed.
   */
  it('keeps the invariant claim on a failed count, offers Retry, and invents no zero', async () => {
    mockQuery({ isError: true });
    const user = userEvent.setup();
    renderOffer('WATERFALL');
    const region = await screen.findByTestId('methodology-align-offer');
    await waitFor(() =>
      expect(region).toHaveTextContent(/This save changed the program default only/i),
    );
    expect(region).toHaveTextContent(/couldn't check which of them differ/i);
    expect(region).not.toHaveTextContent(/0 do not/);
    // No skeleton persists — the reader gets a Retry and the unfiltered matrix.
    expect(screen.getByRole('link', { name: /Open the projects matrix/i })).toHaveAttribute(
      'href',
      '/programs/p-1/settings#projects',
    );
    await user.click(screen.getByTestId('methodology-align-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('exports the canonical deep-link contract (D41)', () => {
    expect(alignMatrixHref('p-9')).toBe(
      '/programs/p-9/settings?bulk=methodology&only=deviating#projects',
    );
  });
});
