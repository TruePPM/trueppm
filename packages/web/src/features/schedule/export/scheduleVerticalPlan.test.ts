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

  it('breaks the Gantt on row boundaries, repeats the header, and avoids a 1-row orphan', () => {
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 600,
      ganttHeader: { top: 100, height: 40 },
      ganttRows: { top: 140, bottom: 580, rowH: 40 },
      cp: null,
      footerTop: 580,
    };
    // Page body 300px: page 1 fills to a row boundary; continuations reserve the 40px
    // repeated Gantt header. A maximal page 2 would strand a single Gantt row on the
    // last page, so the orphan guard (MIN_GANTT_ORPHAN_ROWS=3) backs page 2 off to
    // leave the final page 3 rows + the footer instead of 1.
    expect(planVerticalPages(geom, 300)).toEqual([
      { sy: 0, sh: 300, header: null },
      { sy: 300, sh: 160, header: { kind: 'gantt', height: 40, bandSy: 100 } },
      { sy: 460, sh: 140, header: { kind: 'gantt', height: 40, bandSy: 100 } },
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

  it('keeps the whole CP card together when it fits a page (no split, no orphan CP rows)', () => {
    // Gantt fills part of page 1, leaving room the naive planner would fill with the
    // first 2 CP rows — splitting the card and stranding the rest on page 2 (the user's
    // "page 2 had only 2 CP rows" report). Because the whole 240px card fits a 300px
    // page, the planner drops the interior CP breaks: page 1 ends at the card top and
    // the entire card lands on page 2. issue 1686.
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 440,
      ganttHeader: { top: 60, height: 40 },
      ganttRows: { top: 100, bottom: 180, rowH: 40 },
      cp: { headerTop: 180, rowsTop: 220, rowsBottom: 420, rowH: 40 },
      footerTop: 420,
    };
    const pages = planVerticalPages(geom, 300);
    // No CP "(Continued)" header — the card is never split.
    expect(pages.every((p) => p.header?.kind !== 'cp')).toBe(true);
    // No page boundary falls strictly inside the CP list (220, 420).
    for (const p of pages) {
      const endY = p.sy + p.sh;
      expect(endY > 220 && endY < 420).toBe(false);
    }
  });

  it('still splits a CP card that is taller than one page (interior breaks retained)', () => {
    // The keep-together only applies when the whole card fits; a card taller than the
    // page budget must still break on its grid rows, with the "(Continued)" header.
    const geom: VerticalFlowGeometry = {
      imageHeightPx: 560,
      ganttHeader: { top: 50, height: 30 },
      ganttRows: { top: 80, bottom: 160, rowH: 40 },
      cp: { headerTop: 160, rowsTop: 200, rowsBottom: 520, rowH: 40 },
      footerTop: 520,
    };
    const pages = planVerticalPages(geom, 250);
    expect(pages.some((p) => p.header?.kind === 'cp')).toBe(true);
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
