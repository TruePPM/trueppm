import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SchedulePrintLayout } from './SchedulePrintLayout';
import { buildSchedulePrintData } from './schedulePrintData';
import { planSheetColumns } from './scheduleSheetPlan';
import type { Task, TaskLink } from '@/types';

/**
 * Feed the geometry the layout stamps on its root node into the rasterizer's
 * band planner (at the same pixelRatio 2), to assert the resulting sheet count.
 */
function sheetsFor(root: HTMLElement): number {
  const R = 2;
  const labelStripImg = Number(root.dataset.printLabelStripPx) * R;
  const contentImg = labelStripImg + Number(root.dataset.printChartContentPx) * R;
  return planSheetColumns({
    imageWidthPx: contentImg,
    chartLeftPx: labelStripImg,
    pageWidthPx: Number(root.dataset.printPageWidthPx) * R,
    weekPx: Number(root.dataset.printWeekPx) * R,
  }).columns.length;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: `Task ${id}`,
    start: '2026-04-01',
    finish: '2026-04-05',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  } as Task;
}

const link: TaskLink = {
  id: 'l1',
  sourceId: 'a',
  targetId: 'b',
  type: 'FS',
  lag: 0,
  isCritical: true,
};

function data() {
  return buildSchedulePrintData({
    projectName: 'Apollo',
    tasks: [
      task('a', {
        wbs: '1',
        name: 'Design',
        start: '2026-04-01',
        finish: '2026-04-08',
        isCritical: true,
      }),
      task('b', {
        wbs: '2',
        name: 'Build',
        start: '2026-04-09',
        finish: '2026-04-20',
        isCritical: true,
      }),
      task('m', {
        wbs: '3',
        name: 'Launch',
        isMilestone: true,
        start: '2026-04-21',
        finish: '2026-04-21',
      }),
    ],
    links: [link],
    userName: 'Jane',
    generatedAtLabel: 'Jun 30, 2026',
  });
}

describe('SchedulePrintLayout', () => {
  it('renders the masthead, KPI strip, rows, and a dependency arrow path', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);

    expect(screen.getByText('Apollo')).toBeInTheDocument();
    expect(screen.getByText('Window')).toBeInTheDocument();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    // "Design" appears in both the row label and the critical-path footer chain.
    expect(screen.getAllByText(/Design/).length).toBeGreaterThanOrEqual(1);

    // The FS link is re-projected as an SVG connector path + arrowhead polygon.
    expect(container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('svg polygon').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the critical-path summary box with the driving-chain framing', () => {
    render(<SchedulePrintLayout data={data()} />);

    // The box header is distinct from the KPI "Critical path" cell label.
    expect(screen.getByText('Critical path chain')).toBeInTheDocument();
    // Two critical tasks (Design, Build) drive the finish in this fixture.
    expect(screen.getByText(/activities drive the finish date/)).toBeInTheDocument();
    // The chain is an ordered list — one entry per critical activity.
    const items = screen.getByRole('list').querySelectorAll('li');
    expect(items.length).toBe(2);
  });

  it('stamps a content fingerprint in the footer', () => {
    render(<SchedulePrintLayout data={data()} />);
    expect(screen.getByText(/checksum [0-9a-f]{8}/)).toBeInTheDocument();
  });

  it('renders an empty state when no rows are dated', () => {
    const empty = buildSchedulePrintData({
      projectName: 'Empty',
      tasks: [],
      links: [],
      userName: null,
      generatedAtLabel: 'Jun 30, 2026',
    });
    render(<SchedulePrintLayout data={empty} />);
    expect(screen.getByText(/No activities to plot/)).toBeInTheDocument();
  });

  it('honors the A4 paper width without throwing', () => {
    const { container } = render(<SchedulePrintLayout data={data()} paper="a4" />);
    expect(container.firstChild).toBeTruthy();
  });

  it('keeps the WBS code in its own non-shrinking span so only the name ellipsizes', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);
    // The name sits alone in a truncating span (not "1 Design" together) so the
    // ellipsis only ever eats the name, never the WBS join key (issue 1440).
    const nameSpans = Array.from(container.querySelectorAll('span.truncate')).filter(
      (s) => s.textContent === 'Design',
    );
    expect(nameSpans.length).toBeGreaterThanOrEqual(1);
    // The WBS code lives in a flex-shrink-0 mono span — never clipped.
    const wbsSpans = Array.from(container.querySelectorAll('span.tppm-mono.flex-shrink-0')).filter(
      (s) => s.textContent === '1',
    );
    expect(wbsSpans.length).toBeGreaterThanOrEqual(1);
  });

  it('pins the export surface to the light theme island regardless of app theme (issue #1683)', () => {
    // The surface is mounted in the live app DOM, so under html.dark every
    // CSS-var token would resolve dark on the fixed-white sheet and rasterize
    // light ink on white (WCAG 1.4.3). `.theme-light` re-asserts light values.
    const { container } = render(<SchedulePrintLayout data={data()} />);
    const root = container.firstChild as HTMLElement;
    expect(root.classList.contains('theme-light')).toBe(true);
    // Still the white sheet + light ink token contract.
    expect(root.classList.contains('bg-white')).toBe(true);
    expect(root.classList.contains('text-neutral-text-primary')).toBe(true);
  });

  it('stamps the banding geometry on the root node for the rasterizer', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);
    const root = container.firstChild as HTMLElement;
    expect(Number(root.dataset.printLabelStripPx)).toBeGreaterThan(0);
    expect(Number(root.dataset.printWeekPx)).toBeGreaterThan(0);
    expect(Number(root.dataset.printPageWidthPx)).toBeGreaterThan(0);
  });

  it('renders the masthead + KPI strip (— / 0 cells) on an empty schedule, not a blank page', () => {
    const empty = buildSchedulePrintData({
      projectName: 'Empty',
      tasks: [],
      links: [],
      userName: null,
      generatedAtLabel: 'Jun 30, 2026',
    });
    render(<SchedulePrintLayout data={empty} />);

    // Masthead + KPI strip still render, so the cover reads as an intentional
    // dated document rather than a broken/blank page (issue 1440).
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(screen.getByText('Window')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/No activities to plot/)).toBeInTheDocument();
    expect(screen.getByText(/no dated activities/)).toBeInTheDocument();
  });

  it('bands a long (multi-year) timeline across multiple sheets', () => {
    // A ~18-month schedule would compress below the legibility floor if squeezed
    // to one page, so the scale holds MIN density and the content overflows one
    // sheet — the band planner returns more than one column (issue 1440).
    const long = buildSchedulePrintData({
      projectName: 'Long',
      tasks: [
        task('a', { wbs: '1', name: 'Kickoff', start: '2026-01-01', finish: '2026-02-01' }),
        task('b', { wbs: '2', name: 'Closeout', start: '2027-05-01', finish: '2027-06-30' }),
      ],
      links: [],
      userName: null,
      generatedAtLabel: 'Jun 30, 2026',
    });
    const { container } = render(<SchedulePrintLayout data={long} />);
    expect(sheetsFor(container.firstChild as HTMLElement)).toBeGreaterThan(1);
  });

  it('keeps a short schedule on a single sheet (trailing buffer never spills a page)', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);
    expect(sheetsFor(container.firstChild as HTMLElement)).toBe(1);
  });

  it('paints hard (solid) links above soft (dashed) links so the driving chain stays on top', () => {
    const withSoft = buildSchedulePrintData({
      projectName: 'Apollo',
      tasks: [
        task('a', { wbs: '1', name: 'Design', start: '2026-04-01', finish: '2026-04-08' }),
        task('b', { wbs: '2', name: 'Build', start: '2026-04-10', finish: '2026-04-20' }),
        task('c', { wbs: '3', name: 'Draft', start: '2026-04-10', finish: '2026-04-15' }),
      ],
      links: [
        // Hard FS (no lag) a→b, and a discretionary SS a→c (soft).
        { id: 'hard', sourceId: 'a', targetId: 'b', type: 'FS', lag: 0, isCritical: true },
        { id: 'soft', sourceId: 'a', targetId: 'c', type: 'SS', lag: 0, isCritical: false },
      ],
      userName: 'Jane',
      generatedAtLabel: 'Jun 30, 2026',
    });
    const { container } = render(<SchedulePrintLayout data={withSoft} />);
    const paths = Array.from(container.querySelectorAll('svg path'));
    expect(paths.length).toBe(2);
    // Soft links carry a dash array; hard links do not. The LAST path (painted on
    // top) must be the hard one.
    expect(paths[0].getAttribute('stroke-dasharray')).toBe('3 2');
    expect(paths[paths.length - 1].getAttribute('stroke-dasharray')).toBeNull();
  });
});
