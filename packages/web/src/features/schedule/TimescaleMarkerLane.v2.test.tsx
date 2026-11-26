import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimescaleMarkerLane, markerDefinitionText } from './TimescaleMarkerLane';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { GanttScaleData } from './engine';

// Canvas x per date, so placement is exact: P80 at 400, the commitment at 700.
vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    dateToLeft: vi.fn((iso: string) =>
      iso === '2026-12-10' ? 400 : iso === '2027-01-15' ? 700 : -5000,
    ),
  };
});

const SCALES = { totalWidth: 4000 } as unknown as GanttScaleData;
const RESULT = {
  ...FIXTURE_MC_RESULT,
  p80: '2026-12-10',
  commitmentDate: '2027-01-15',
  lastRunAt: '2026-11-20T10:00:00Z',
  definitions: { p80: 'Server P80 sentence.', commitment_date: 'Server commitment sentence.' },
};

function scrollRef(width: number) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width });
  Object.defineProperty(el, 'scrollLeft', { value: 0 });
  return { current: el };
}

describe('TimescaleMarkerLane under shell v2 (#5106)', () => {
  it('places the P80 tick and the Commit marker at their dates, opening away from each other', () => {
    render(
      <TimescaleMarkerLane
        shellV2
        result={RESULT}
        scaleData={SCALES}
        canvasScrollRef={scrollRef(1200)}
      />,
    );
    expect(screen.getByTestId('marker-lane-tick-p80').style.left).toBe('400px');
    expect(screen.getByTestId('marker-lane-tick-target').style.left).toBe('700px');
    expect(screen.getByTestId('marker-lane-p80').dataset.side).toBe('left');
    expect(screen.getByTestId('marker-lane-target').dataset.side).toBe('right');
    expect(screen.getByTestId('marker-lane-target').textContent).toMatch(/^Commit/);
  });

  it('carries the server definitions and as_of as tooltip and screen-reader text', () => {
    render(
      <TimescaleMarkerLane
        shellV2
        result={RESULT}
        scaleData={SCALES}
        canvasScrollRef={scrollRef(1200)}
      />,
    );
    const commit = screen.getByTestId('marker-lane-target');
    expect(commit.dataset.definition).toContain('Server commitment sentence.');
    expect(commit.parentElement?.getAttribute('title')).toContain('Server commitment sentence.');
    expect(commit.className).toContain('pointer-events-auto');
    const list = screen.getByRole('list', { name: 'Forecast markers' });
    expect(list).toHaveTextContent('Server P80 sentence.');
    expect(list).toHaveTextContent('Server commitment sentence.');
    expect(list).toHaveTextContent(/As of/);
  });

  it('keeps v1 untouched: Target label, no definitions list', () => {
    render(
      <TimescaleMarkerLane result={RESULT} scaleData={SCALES} canvasScrollRef={scrollRef(1200)} />,
    );
    expect(screen.getByTestId('marker-lane-target').textContent).toMatch(/^Target/);
    expect(screen.queryByTestId('marker-lane-definitions')).not.toBeInTheDocument();
  });

  it('omits a definition the payload does not carry rather than writing its own', () => {
    expect(markerDefinitionText('P80 finish', '2026-12-10', undefined, undefined)).not.toMatch(
      /simulated|As of/,
    );
  });
});
