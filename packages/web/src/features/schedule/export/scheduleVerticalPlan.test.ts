import { describe, it, expect } from 'vitest';
import {
  planVerticalPages,
  pageLabel,
  CP_CONTINUED_HEADER_PX,
  type VerticalFlowGeometry,
} from './scheduleVerticalPlan';

describe('planVerticalPages', () => {
  it('emits a single full-height page when the whole report fits', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 300,
      ganttHeader: { top: 100, height: 40 },
      ganttRows: { top: 140, bottom: 280, rowH: 40 },
      cp: null,
      footerTop: 280,
    };
    expect(planVerticalPages(geom, 500)).toEqual([{ sy: 0, sh: 300, header: null }]);
  });

  it('breaks the Gantt on row boundaries and repeats the Gantt header on continuations', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 600,
      ganttHeader: { top: 100, height: 40 },
      ganttRows: { top: 140, bottom: 580, rowH: 40 },
      cp: null,
      footerTop: 580,
    };
    // Page body 300px: page 1 fills to a row boundary; continuations reserve the
    // 40px repeated Gantt header, so they fill 260px worth of whole rows.
    expect(planVerticalPages(geom, 300)).toEqual([
      { sy: 0, sh: 300, header: null },
      { sy: 300, sh: 240, header: { kind: 'gantt', height: 40, bandSy: 100 } },
      { sy: 540, sh: 60, header: { kind: 'gantt', height: 40, bandSy: 100 } },
    ]);
  });

  it('repeats the CP "(Continued)" running header when the CP list overflows', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 560,
      ganttHeader: { top: 50, height: 30 },
      ganttRows: { top: 80, bottom: 160, rowH: 40 },
      cp: { headerTop: 160, rowsTop: 200, rowsBottom: 520, rowH: 40 },
      footerTop: 520,
    };
    // Continuation pages reserve the CP running-header band (CP_CONTINUED_HEADER_PX),
    // so each fills 250 − 52 = 198px worth of whole 40px grid rows (→ 160px).
    expect(planVerticalPages(geom, 250)).toEqual([
      { sy: 0, sh: 240, header: null },
      { sy: 240, sh: 160, header: { kind: 'cp', height: CP_CONTINUED_HEADER_PX } },
      { sy: 400, sh: 160, header: { kind: 'cp', height: CP_CONTINUED_HEADER_PX } },
    ]);
  });

  it('starts the CP card on a fresh page rather than splitting its header from row 1', () => {
    // Gantt fills page 1 to its end; the CP card cannot fit in the remainder, so
    // page 2 starts cleanly at the CP card top (a safe break), no repeat header.
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 520,
      ganttHeader: { top: 60, height: 40 },
      ganttRows: { top: 100, bottom: 300, rowH: 40 },
      cp: { headerTop: 300, rowsTop: 340, rowsBottom: 500, rowH: 40 },
      footerTop: 500,
    };
    const pages = planVerticalPages(geom, 320);
    // The first continuation begins exactly at the CP card top with no repeat.
    const cpStart = pages.find((p) => p.sy === 300);
    expect(cpStart).toBeDefined();
    expect(cpStart?.header).toBeNull();
  });

  it('keeps the footer together (never a break inside the sign-off strip)', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 600,
      ganttHeader: { top: 100, height: 40 },
      ganttRows: { top: 140, bottom: 500, rowH: 40 },
      cp: null,
      footerTop: 500,
    };
    const pages = planVerticalPages(geom, 260);
    // No page boundary lands strictly inside the footer region (500, 600).
    for (const p of pages) {
      const endY = p.sy + p.sh;
      const insideFooter = endY > 500 && endY < 600;
      expect(insideFooter).toBe(false);
    }
    // The last page ends exactly at the report end.
    expect(pages[pages.length - 1].sy + pages[pages.length - 1].sh).toBe(600);
  });

  it('covers [0, imageHeight] contiguously and terminates even with a tiny page budget', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 400,
      ganttHeader: { top: 40, height: 30 },
      ganttRows: { top: 70, bottom: 390, rowH: 40 },
      cp: null,
      footerTop: 390,
    };
    const pages = planVerticalPages(geom, 10); // budget smaller than one row
    expect(pages.length).toBeGreaterThan(1);
    // Contiguous, no gaps or overlaps.
    let y = 0;
    for (const p of pages) {
      expect(p.sy).toBe(y);
      y = p.sy + p.sh;
    }
    expect(y).toBe(400);
  });

  it('produces no CP headers when the CP block is absent', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 600,
      ganttHeader: { top: 100, height: 40 },
      ganttRows: { top: 140, bottom: 580, rowH: 40 },
      cp: null,
      footerTop: 580,
    };
    const pages = planVerticalPages(geom, 300);
    expect(pages.every((p) => p.header?.kind !== 'cp')).toBe(true);
  });
});

describe('pageLabel', () => {
  it('formats a 1-based "Page n of N" caption', () => {
    expect(pageLabel(2, 3)).toBe('Page 2 of 3');
  });
});
