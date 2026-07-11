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

/**
 * A fixture exercising every ADR-0277 state: a critical-AND-complete task (red frame,
 * full green fill), a behind task (amber frame + hatch), an overdue task, a future
 * pending milestone, and an overdue pending milestone. Rendered with a data date
 * inside the span so the overdue markers + data-date pill appear.
 */
function richData() {
  return buildSchedulePrintData({
    projectName: 'Apollo',
    tasks: [
      task('crit', {
        wbs: '1',
        name: 'Design',
        start: '2026-04-01',
        finish: '2026-04-08',
        isCritical: true,
        progress: 100,
      }),
      task('beh', {
        wbs: '2',
        name: 'Build',
        start: '2026-04-09',
        finish: '2026-04-20',
        totalFloat: -2,
        progress: 30,
      }),
      task('od', {
        wbs: '3',
        name: 'Verify',
        start: '2026-04-10',
        finish: '2026-04-15',
        progress: 40,
      }),
      task('ms', { wbs: '4', name: 'Launch', isMilestone: true, start: '2026-05-01', finish: '2026-05-01' }),
      task('msod', { wbs: '5', name: 'Gate', isMilestone: true, start: '2026-04-12', finish: '2026-04-12' }),
    ],
    links: [],
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
    const paths = container.querySelectorAll('svg path');
    const polys = container.querySelectorAll('svg polygon');
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(polys.length).toBeGreaterThanOrEqual(1);

    // Arrow ink is set via an inline-`style` CSS var, NOT a Tailwind stroke-/fill-
    // class — html-to-image drops CSS-class strokes on SVG paths, so a class-based
    // connector rasterizes as 0 ink while its arrowhead survives (issue 1694). It is
    // charcoal (neutral ink), never the red critical token.
    const path = paths[0] as SVGElement;
    const poly = polys[0] as SVGElement;
    expect(path.getAttribute('style')).toContain('var(--neutral-text-secondary)');
    expect(poly.getAttribute('style')).toContain('var(--neutral-text-secondary)');
    expect(path.getAttribute('class') ?? '').not.toContain('stroke-semantic-critical');
    expect(poly.getAttribute('class') ?? '').not.toContain('fill-semantic-critical');
  });

  it('stamps the vertical-flow markers + row counts the paginator measures (issue 1694)', () => {
    const { container } = render(<SchedulePrintLayout data={data()} />);
    const root = container.firstChild as HTMLElement;
    // Block markers the rasterizer measures for safe page breaks + repeated headers.
    expect(container.querySelector('[data-print-vmark="gantt"]')).toBeTruthy();
    expect(container.querySelector('[data-print-vmark="gantt-rows"]')).toBeTruthy();
    expect(container.querySelector('[data-print-vmark="cp"]')).toBeTruthy();
    expect(container.querySelector('[data-print-vmark="cp-list"]')).toBeTruthy();
    expect(container.querySelector('[data-print-vmark="footer"]')).toBeTruthy();
    // Row counts drive the per-row pitch (region height ÷ count).
    expect(Number(root.dataset.printGanttRowCount)).toBe(3); // Design, Build, Launch
    expect(Number(root.dataset.printCpRowCount)).toBe(2); // 2 critical activities
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

  // ── ADR-0277: risk on the border, overdue markers, leaders, expanded legend ──
  const rowsRegion = (c: HTMLElement) =>
    c.querySelector('[data-print-vmark="gantt-rows"]') as HTMLElement;

  it('colors the bar BORDER by risk band, with the green progress fill INSIDE the frame', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    const region = rowsRegion(container);
    // The critical task bar is a red 2px frame — NOT a red fill (so a completed
    // critical task keeps its critical signal instead of being overpainted green).
    const critBars = Array.from(
      region.querySelectorAll('span.rounded-sm.border-2.border-semantic-critical'),
    );
    expect(critBars.length).toBeGreaterThanOrEqual(1);
    expect(critBars[0].className).not.toContain('bg-semantic-critical');
    // The interior fill is green progress (100% here) sitting inside the red frame.
    expect(critBars[0].querySelector('.bg-semantic-on-track')).toBeTruthy();
  });

  it('textures a behind-schedule bar with the diagonal hatch overlay', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    const hatched = Array.from(rowsRegion(container).querySelectorAll('span')).filter((s) =>
      (s.getAttribute('style') ?? '').includes('repeating-linear-gradient'),
    );
    expect(hatched.length).toBeGreaterThanOrEqual(1);
  });

  it('draws an overdue task as a red past-due flag + a dashed red overrun tail', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    const region = rowsRegion(container);
    const flags = Array.from(region.querySelectorAll('polygon')).filter((p) =>
      (p.getAttribute('style') ?? '').includes('var(--semantic-critical)'),
    );
    const tails = Array.from(region.querySelectorAll('line')).filter((l) =>
      (l.getAttribute('style') ?? '').includes('var(--semantic-critical)'),
    );
    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(tails.length).toBeGreaterThanOrEqual(1);
    expect(tails[0].getAttribute('stroke-dasharray')).toBe('2 2');
  });

  it('has no overdue markers when no data date is supplied', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} />);
    const region = rowsRegion(container);
    const criticalFills = Array.from(region.querySelectorAll('polygon')).filter((p) =>
      (p.getAttribute('style') ?? '').includes('var(--semantic-critical)'),
    );
    expect(criticalFills.length).toBe(0);
  });

  it('renders milestones as filled/hollow diamonds and an overdue one as hollow-red + "!"', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    const region = rowsRegion(container);
    // Future pending milestone: hollow diamond with a navy (not amber) outline —
    // brand-accent is ~2.2:1 on white so it's the fill only (shape cue, resolves #1686).
    const pendingHollow = Array.from(region.querySelectorAll('span.rotate-45')).filter(
      (s) =>
        s.className.includes('bg-transparent') &&
        s.className.includes('border-neutral-text-primary') &&
        !s.className.includes('border-2'),
    );
    expect(pendingHollow.length).toBeGreaterThanOrEqual(1);
    // Overdue pending milestone: hollow with a red 2px outline + a bold "!" glyph.
    const overdueDiamond = Array.from(region.querySelectorAll('span.rotate-45')).filter((s) =>
      s.className.includes('border-semantic-critical'),
    );
    expect(overdueDiamond.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('!').length).toBeGreaterThanOrEqual(1);
  });

  it('draws faint round-dotted row leaders (distinct from dashed soft arrows)', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    const leaders = Array.from(rowsRegion(container).querySelectorAll('line')).filter(
      (l) => l.getAttribute('stroke-dasharray') === '0.5 4',
    );
    expect(leaders.length).toBeGreaterThanOrEqual(1);
    // Round caps + faint ink (neutral-text-disabled — distinct from gridlines, never
    // the darker soft-arrow secondary).
    expect(leaders[0].getAttribute('stroke-linecap')).toBe('round');
    expect(leaders[0].getAttribute('style')).toContain('var(--neutral-text-disabled)');
  });

  it('labels the data-date line with a sage pill showing the date', () => {
    const { container } = render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    // The line span carries no text; the pill is the one bg-brand-primary span with text.
    const pill = Array.from(container.querySelectorAll('span.bg-brand-primary')).find(
      (s) => (s.textContent ?? '').trim().length > 0,
    );
    expect(pill).toBeTruthy();
  });

  it('renders the expanded three-group legend explaining every mark', () => {
    render(<SchedulePrintLayout data={richData()} dataDate="2026-04-25" />);
    for (const label of ['Bars', 'Links', 'Markers']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // New entries beyond the original 4-chip legend.
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('At risk / behind')).toBeInTheDocument();
    expect(screen.getByText('Milestone pending')).toBeInTheDocument();
    expect(screen.getByText('Row guide')).toBeInTheDocument();
    expect(screen.getByText(/Driving/)).toBeInTheDocument();
    expect(screen.getByText(/Discretionary/)).toBeInTheDocument();
  });

  it('renders the "Unscheduled — Planned Work" section with keep-together + text markers (#1799)', () => {
    const printData = buildSchedulePrintData({
      projectName: 'Apollo',
      tasks: [
        task('a', { wbs: '1', name: 'Design', start: '2026-04-01', finish: '2026-04-05' }),
        task('b', {
          wbs: '2',
          name: 'Contact dedupe',
          status: 'BACKLOG',
          sprintId: 's1',
          start: '',
          finish: '',
          plannedStart: null,
        }),
      ],
      links: [],
      userName: 'Jane',
      generatedAtLabel: 'Jun 30, 2026',
      sprints: [
        {
          id: 's1',
          name: 'Build Sprint 3',
          state: 'PLANNED',
          start_date: '2026-07-17',
          finish_date: '2026-07-30',
        } as unknown as import('@/types').ApiSprint,
      ],
    });
    const { container } = render(<SchedulePrintLayout data={printData} />);

    // The section, its keep-together vmark, and the honest caption render.
    const card = container.querySelector('[data-print-vmark="unscheduled"]');
    expect(card).toBeTruthy();
    expect(screen.getByText('Unscheduled — Planned Work')).toBeInTheDocument();
    expect(screen.getByText(/planned, not a committed date/)).toBeInTheDocument();
    expect(screen.getByText('Targeted: Build Sprint 3 · Planned')).toBeInTheDocument();
    expect(screen.getByText('Contact dedupe')).toBeInTheDocument();
    // Every string in the section is marked selectable for the PDF text layer.
    expect(card!.querySelectorAll('[data-print-text="unscheduled"]').length).toBeGreaterThanOrEqual(2);
    // The carved-out backlog row is NOT charted as a blank Gantt row.
    expect(printData.rows.map((r) => r.id)).toEqual(['a']);
  });
});
