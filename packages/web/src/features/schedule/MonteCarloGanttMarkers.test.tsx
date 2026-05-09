import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MonteCarloGanttMarkers } from './MonteCarloGanttMarkers';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { GanttScaleData } from './engine';

// dateToLeft is called inside a scroll-event handler (useEffect). jsdom has no
// real layout, so we just verify the markers are in the DOM and aria-hidden.
vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    dateToLeft: vi.fn(() => 100),
  };
});

const MOCK_SCALE_DATA: GanttScaleData = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2027-01-01T00:00:00.000Z'),
  totalWidth: 2000,
  zoomLevel: 'week',
  pxPerMs: 2000 / (365 * 24 * 60 * 60 * 1000),
} as unknown as GanttScaleData;

describe('MonteCarloGanttMarkers', () => {
  it('renders nothing when result is null', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <MonteCarloGanttMarkers result={null} scaleData={MOCK_SCALE_DATA} canvasScrollRef={ref} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when scaleData is null', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <MonteCarloGanttMarkers result={FIXTURE_MC_RESULT} scaleData={null} canvasScrollRef={ref} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders all three markers when result and scaleData are provided', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MonteCarloGanttMarkers
        result={FIXTURE_MC_RESULT}
        scaleData={MOCK_SCALE_DATA}
        canvasScrollRef={ref}
      />,
    );
    expect(screen.getByTestId('mc-marker-p50')).toBeInTheDocument();
    expect(screen.getByTestId('mc-marker-p80')).toBeInTheDocument();
    expect(screen.getByTestId('mc-marker-p95')).toBeInTheDocument();
  });

  it('marks all markers as aria-hidden (decorative overlays)', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MonteCarloGanttMarkers
        result={FIXTURE_MC_RESULT}
        scaleData={MOCK_SCALE_DATA}
        canvasScrollRef={ref}
      />,
    );
    expect(screen.getByTestId('mc-marker-p50')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('mc-marker-p80')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('mc-marker-p95')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders label chips with colon-separated date text', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MonteCarloGanttMarkers
        result={FIXTURE_MC_RESULT}
        scaleData={MOCK_SCALE_DATA}
        canvasScrollRef={ref}
      />,
    );
    // Chips show "P50: Oct 5", "P80: Nov 3", "P95: Nov 30" (from FIXTURE_MC_RESULT)
    expect(screen.getByText(/P50:/)).toBeInTheDocument();
    expect(screen.getByText(/P80:/)).toBeInTheDocument();
    expect(screen.getByText(/P95:/)).toBeInTheDocument();
  });

  it('markers have pointer-events-none so they do not block Gantt interaction', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MonteCarloGanttMarkers
        result={FIXTURE_MC_RESULT}
        scaleData={MOCK_SCALE_DATA}
        canvasScrollRef={ref}
      />,
    );
    const p80 = screen.getByTestId('mc-marker-p80');
    expect(p80.className).toContain('pointer-events-none');
  });
});
