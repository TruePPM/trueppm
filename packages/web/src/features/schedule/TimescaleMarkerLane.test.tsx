import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimescaleMarkerLane } from './TimescaleMarkerLane';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { GanttScaleData } from './engine';

vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return { ...actual, dateToLeft: vi.fn(() => 100) };
});

const SCALES = { totalWidth: 2000 } as unknown as GanttScaleData;

describe('TimescaleMarkerLane', () => {
  it('renders nothing without scale data', () => {
    const { container } = render(
      <TimescaleMarkerLane result={null} scaleData={null} canvasScrollRef={createRef()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('carries Today alone when there is no forecast', () => {
    render(<TimescaleMarkerLane result={null} scaleData={SCALES} canvasScrollRef={createRef()} />);
    expect(screen.getByTestId('marker-lane-today')).toBeInTheDocument();
    expect(screen.queryByTestId('marker-lane-p80')).not.toBeInTheDocument();
    expect(screen.queryByTestId('marker-lane-target')).not.toBeInTheDocument();
  });

  it('is an 18px, non-interactive, aria-hidden lane', () => {
    render(<TimescaleMarkerLane result={null} scaleData={SCALES} canvasScrollRef={createRef()} />);
    const lane = screen.getByTestId('marker-lane');
    expect(lane.style.height).toBe('18px');
    expect(lane).toHaveAttribute('aria-hidden', 'true');
    expect(lane.className).toContain('pointer-events-none');
  });

  it('adds P80 once and Target only when the result names a commitment', () => {
    const { rerender } = render(
      <TimescaleMarkerLane
        result={{ ...FIXTURE_MC_RESULT, commitmentDate: null }}
        scaleData={SCALES}
        canvasScrollRef={createRef()}
      />,
    );
    expect(screen.getAllByTestId('marker-lane-p80')).toHaveLength(1);
    expect(screen.queryByTestId('marker-lane-target')).not.toBeInTheDocument();
    rerender(
      <TimescaleMarkerLane
        result={{ ...FIXTURE_MC_RESULT, commitmentDate: '2026-12-01' }}
        scaleData={SCALES}
        canvasScrollRef={createRef()}
      />,
    );
    expect(screen.getByTestId('marker-lane-target')).toBeInTheDocument();
  });
});
