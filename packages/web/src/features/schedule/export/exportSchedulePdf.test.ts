import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportSchedulePdf, scheduledPdfFileName, type ExportProgress } from './exportSchedulePdf';

// html-to-image + jspdf are dynamically imported by the helper; mock both. Spies
// go through vi.hoisted so the hoisted vi.mock factories can close over them.
const {
  toPng,
  addImage,
  addPage,
  save,
  output,
  text,
  setFontSize,
  setTextColor,
  autoPrint,
  line,
  setDrawColor,
  setLineWidth,
  dispatchPrintViaIframe,
  pdfCaps,
} = vi.hoisted(() => ({
  toPng: vi.fn(),
  addImage: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  output: vi.fn(),
  text: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  autoPrint: vi.fn(),
  line: vi.fn(),
  setDrawColor: vi.fn(),
  setLineWidth: vi.fn(),
  dispatchPrintViaIframe: vi.fn(),
  // Which OPTIONAL jsPDF surfaces this test's double exposes. Every stamp helper
  // in the exporter is `typeof`-guarded so a leaner PDF object still exports;
  // flipping these drives the guarded-off legs. Defaults mirror the historical
  // double (text + autoPrint present, no vector line API).
  pdfCaps: { text: true, autoPrint: true, line: false },
}));
vi.mock('html-to-image', () => ({ toPng }));
vi.mock('jspdf', () => ({
  jsPDF: class {
    addImage = addImage;
    addPage = addPage;
    save = save;
    output = output;
    setFontSize = setFontSize;
    setTextColor = setTextColor;
    // A4 landscape in points; the mock ignores the `format` option.
    internal = { pageSize: { getWidth: () => 841.89, getHeight: () => 595.28 } };
    // Optional surfaces — attached per `pdfCaps` so tests can exercise a jsPDF
    // double that lacks them.
    text?: typeof text;
    autoPrint?: typeof autoPrint;
    line?: typeof line;
    setDrawColor?: typeof setDrawColor;
    setLineWidth?: typeof setLineWidth;
    constructor() {
      // Real jsPDF exposes a text layer; the banded path stamps "Sheet n of N".
      if (pdfCaps.text) this.text = text;
      // Embeds the auto-print OpenAction on the print destination (#1970).
      if (pdfCaps.autoPrint) this.autoPrint = autoPrint;
      if (pdfCaps.line) {
        this.line = line;
        this.setDrawColor = setDrawColor;
        this.setLineWidth = setLineWidth;
      }
    }
  },
}));
// The print destination dispatches through this shared helper; assert on the call,
// not on real iframe/OS behavior (undrivable in jsdom).
vi.mock('../../export/printPdf', () => ({ dispatchPrintViaIframe }));

/** Stub `Image` so `loadImage` resolves deterministically with a known size. */
function stubImage(width: number, height: number) {
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = width;
    height = height;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', MockImage);
}

/** Install a working fake <canvas> so the multi-band slicing loop runs. */
function installFakeCanvas(ctx: Partial<CanvasRenderingContext2D> | null) {
  const fakeCtx = ctx as unknown as CanvasRenderingContext2D | null;
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => fakeCtx,
        toDataURL: () => 'data:image/png;base64,slice',
      } as unknown as HTMLCanvasElement;
    }
    return realCreate(tag);
  });
  return realCreate;
}

beforeEach(() => {
  toPng.mockReset().mockResolvedValue('data:image/png;base64,abc');
  addImage.mockClear();
  addPage.mockClear();
  save.mockClear();
  output.mockReset().mockImplementation((type: string) => (type === 'blob' ? { size: 2048 } : ''));
  text.mockClear();
  setFontSize.mockClear();
  setTextColor.mockClear();
  autoPrint.mockClear();
  line.mockClear();
  setDrawColor.mockClear();
  setLineWidth.mockClear();
  dispatchPrintViaIframe.mockClear();
  pdfCaps.text = true;
  pdfCaps.autoPrint = true;
  pdfCaps.line = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exportSchedulePdf — single page', () => {
  it('rasterizes once and emits one page when the bitmap fits', async () => {
    stubImage(800, 400);
    const node = document.createElement('div');

    const result = await exportSchedulePdf(node, { fileName: 'apollo_schedule.pdf' });

    expect(toPng).toHaveBeenCalledWith(node, { pixelRatio: 2 });
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addPage).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('apollo_schedule.pdf');
    expect(result).toMatchObject({
      pageCount: 1,
      paper: 'letter',
      canceled: false,
      byteSize: 2048,
    });
  });

  it('propagates the A4 paper choice into the result', async () => {
    stubImage(800, 400);
    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'a4.pdf',
      paper: 'a4',
    });
    expect(result.paper).toBe('a4');
  });

  it('reports determinate progress ending at finalize with done === total', async () => {
    stubImage(800, 400);
    const events: ExportProgress[] = [];
    await exportSchedulePdf(document.createElement('div'), {
      fileName: 'p.pdf',
      onProgress: (e) => events.push(e),
    });

    expect(events[0].phase).toBe('rasterize');
    const last = events[events.length - 1];
    expect(last.phase).toBe('finalize');
    expect(last.done).toBe(last.total);
    // `done` never decreases.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done);
    }
  });
});

describe('exportSchedulePdf — horizontal banding', () => {
  it('slices a wide timeline into columns via bandWidthPx', async () => {
    stubImage(1600, 400); // 2 columns at bandWidthPx 800, 1 row
    const drawImage = vi.fn();
    installFakeCanvas({ clearRect: vi.fn(), drawImage });

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'wide.pdf',
      bandWidthPx: 800,
    });

    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(addPage).toHaveBeenCalledTimes(1);
    expect(addImage).toHaveBeenCalledTimes(2);
    expect(result.pageCount).toBe(2);
    expect(save).toHaveBeenCalledWith('wide.pdf');
  });

  it('falls back to a single page when no 2D context is available', async () => {
    stubImage(1600, 400);
    installFakeCanvas(null); // getContext('2d') → null

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'noctx.pdf',
      bandWidthPx: 800,
    });

    expect(addPage).not.toHaveBeenCalled();
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(result.pageCount).toBe(1);
    expect(save).toHaveBeenCalledWith('noctx.pdf');
  });
});

describe('exportSchedulePdf — week-snapped banding with a repeated label column', () => {
  /** A node stamped with the print surface's geometry (CSS px), as the layout does. */
  function geomNode(): HTMLElement {
    const node = document.createElement('div');
    node.dataset.printLabelStripPx = '150'; // ×2 → 300 img px
    node.dataset.printWeekPx = '35'; // ×2 → 70 img px per week
    node.dataset.printPageWidthPx = '500'; // ×2 → 1000 img px per sheet
    return node;
  }

  it('repeats the label strip on every sheet and stamps a "Sheet n of N" caption', async () => {
    // 2000px-wide bitmap → chart 300..2000 (1700) at a 700px week-snapped band → 3 sheets.
    stubImage(2000, 400);
    const drawImage = vi.fn();
    installFakeCanvas({ clearRect: vi.fn(), drawImage });

    const result = await exportSchedulePdf(geomNode(), { fileName: 'wide.pdf' });

    expect(result.pageCount).toBe(3);
    expect(addPage).toHaveBeenCalledTimes(2);
    expect(addImage).toHaveBeenCalledTimes(3);
    // Two draws per sheet: the frozen label strip, then the chart band.
    expect(drawImage).toHaveBeenCalledTimes(6);
    // Every sheet carries a real (selectable) caption.
    expect(text).toHaveBeenCalledWith('Sheet 1 of 3', expect.any(Number), expect.any(Number), {
      align: 'right',
    });
    expect(text).toHaveBeenCalledWith('Sheet 3 of 3', expect.any(Number), expect.any(Number), {
      align: 'right',
    });
    expect(save).toHaveBeenCalledWith('wide.pdf');
  });

  it('stays on the single-page fast path when the timeline fits one sheet wide', async () => {
    stubImage(700, 400); // chart 300..700 (400) < one 700px band → 1 column
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(geomNode(), { fileName: 'narrow.pdf' });

    expect(result.pageCount).toBe(1);
    expect(addPage).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('aborts mid-banding between sheets without saving', async () => {
    stubImage(2000, 400);
    const controller = new AbortController();
    const drawImage = vi.fn(() => controller.abort());
    installFakeCanvas({ clearRect: vi.fn(), drawImage });

    const result = await exportSchedulePdf(geomNode(), {
      fileName: 'cancel-band.pdf',
      signal: controller.signal,
    });

    expect(result.canceled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — cancellation', () => {
  it('aborts before rasterizing when the signal is already aborted', async () => {
    stubImage(800, 400);
    const controller = new AbortController();
    controller.abort();

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'x.pdf',
      signal: controller.signal,
    });

    expect(toPng).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ canceled: true, pageCount: 0 });
  });

  it('aborts mid-export between bands without saving', async () => {
    stubImage(1600, 400); // 2 bands
    const controller = new AbortController();
    // Abort while drawing the first band, so the second band's guard trips.
    const drawImage = vi.fn(() => controller.abort());
    installFakeCanvas({ clearRect: vi.fn(), drawImage });

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'cancel.pdf',
      bandWidthPx: 800,
      signal: controller.signal,
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.canceled).toBe(true);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});

describe('exportSchedulePdf — row-aware vertical pagination (issue 1694)', () => {
  /** A DOMRect stub carrying only the fields readVFlowGeometry reads. */
  function rectAt(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      height: bottom - top,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /**
   * Build a print-surface node with the `data-print-vmark` markers + row counts and
   * stubbed rects (CSS px; the rasterizer ×2's them). No horizontal band geometry is
   * stamped, so the export takes the single-column vertical path.
   */
  function vflowNode(
    ganttRowCount: number,
    cpRowCount: number | null,
    rects: Record<string, [number, number]>,
    rootBottom: number,
  ): HTMLElement {
    const root = document.createElement('div');
    root.dataset.printGanttRowCount = String(ganttRowCount);
    if (cpRowCount != null) root.dataset.printCpRowCount = String(cpRowCount);
    root.getBoundingClientRect = () => rectAt(0, rootBottom);
    for (const [mark, [top, bottom]] of Object.entries(rects)) {
      const el = document.createElement('div');
      el.dataset.printVmark = mark;
      el.getBoundingClientRect = () => rectAt(top, bottom);
      root.appendChild(el);
    }
    return root;
  }

  it('breaks a tall Gantt across pages, repeating the header, with "Page n of N"', async () => {
    // Tall Gantt rows region (126..1640 img px) over a ~707px page body → 3 pages;
    // continuation pages re-composite the Gantt header band (extra drawImage calls).
    stubImage(1000, 1800);
    const drawImage = vi.fn();
    installFakeCanvas({ clearRect: vi.fn(), drawImage });

    const node = vflowNode(
      30,
      4,
      {
        gantt: [45, 400],
        'gantt-rows': [63, 820],
        cp: [825, 900],
        'cp-list': [840, 880],
        footer: [885, 895],
      },
      900,
    );

    const result = await exportSchedulePdf(node, { fileName: 'tall.pdf' });

    expect(result.pageCount).toBeGreaterThan(1);
    expect(addPage).toHaveBeenCalled();
    // A repeated Gantt header adds a second drawImage on each continuation page, so
    // total draws exceed the page count.
    expect(drawImage.mock.calls.length).toBeGreaterThan(result.pageCount);
    // Real "Page n of N" caption on the first page.
    expect(text).toHaveBeenCalledWith(
      expect.stringMatching(/^Page 1 of \d+$/),
      expect.any(Number),
      expect.any(Number),
      { align: 'right' },
    );
    expect(save).toHaveBeenCalledWith('tall.pdf');
  });

  it('stamps a centered "continued on next page" caption on every page but the last', async () => {
    // Same tall-Gantt geometry as above → multiple pages. The reserved footer band
    // hosts the centered continuation caption on non-final pages (issue 1686).
    stubImage(1000, 1800);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const node = vflowNode(
      30,
      4,
      {
        gantt: [45, 400],
        'gantt-rows': [63, 820],
        cp: [825, 900],
        'cp-list': [840, 880],
        footer: [885, 895],
      },
      900,
    );

    const result = await exportSchedulePdf(node, { fileName: 'tall.pdf' });

    // Centered continuation caption fires (align center), and once per non-final page.
    const continuedCalls = text.mock.calls.filter((c) => c[0] === 'continued on next page');
    expect(continuedCalls.length).toBe(result.pageCount - 1);
    expect(continuedCalls[0][3]).toMatchObject({ align: 'center' });
  });

  it('stamps a "Critical Path Chain (Continued)" header when the CP list overflows', async () => {
    // Small Gantt, huge CP list (300..1700 img px) → the CP chain spans pages and the
    // continuation gets the running text header.
    stubImage(1000, 1760);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const node = vflowNode(
      4,
      40,
      {
        gantt: [45, 130],
        'gantt-rows': [63, 130],
        cp: [135, 850],
        'cp-list': [150, 850],
        footer: [855, 870],
      },
      880,
    );

    const result = await exportSchedulePdf(node, { fileName: 'cp.pdf' });

    expect(result.pageCount).toBeGreaterThan(1);
    expect(text).toHaveBeenCalledWith(
      'Critical Path Chain (Continued)',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('falls back to the plain path (no markers) so jsdom nodes still export one page', async () => {
    // A bare node has no vmarks; getBoundingClientRect is 0 → vflow is null → the
    // plain single-image path runs (the pre-existing behavior, no caption).
    stubImage(800, 400);
    const result = await exportSchedulePdf(document.createElement('div'), { fileName: 'bare.pdf' });
    expect(result.pageCount).toBe(1);
    expect(text).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — selectable text layer (issue 1687)', () => {
  function stubRect(el: HTMLElement, box: [number, number, number, number]) {
    const [left, top, width, height] = box;
    el.getBoundingClientRect = () =>
      ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  /** A print node carrying one opt-in `data-print-text` run with a measured box. */
  function textNode(): HTMLElement {
    const node = document.createElement('div');
    const row = document.createElement('div');
    row.dataset.printText = 'row';
    row.textContent = '1.2 Design Foundations';
    stubRect(row, [10, 10, 200, 20]);
    node.appendChild(row);
    return node;
  }

  it('stamps invisible selectable text over the raster on the single-page path', async () => {
    stubImage(800, 400);
    const result = await exportSchedulePdf(textNode(), { fileName: 'apollo_schedule.pdf' });

    expect(result.pageCount).toBe(1);
    expect(text).toHaveBeenCalledWith(
      '1.2 Design Foundations',
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ renderingMode: 'invisible', baseline: 'top' }),
    );
    expect(save).toHaveBeenCalledWith('apollo_schedule.pdf');
  });

  it('does not stamp any text for a surface with no opt-in markers', async () => {
    stubImage(800, 400);
    await exportSchedulePdf(document.createElement('div'), { fileName: 'plain.pdf' });
    expect(text).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — print destination (#1970)', () => {
  /** Stub `URL.createObjectURL` so a blob URL exists and the print dispatch fires. */
  function stubObjectUrl() {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:print'),
      revokeObjectURL: vi.fn(),
    });
  }

  it('embeds auto-print and dispatches to the print dialog instead of saving', async () => {
    stubImage(800, 400);
    stubObjectUrl();

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'apollo_schedule.pdf',
      destination: 'print',
    });

    // Auto-print action embedded BEFORE the blob is materialized.
    expect(autoPrint).toHaveBeenCalledTimes(1);
    // Sent to the print dialog, never downloaded.
    expect(dispatchPrintViaIframe).toHaveBeenCalledTimes(1);
    expect(dispatchPrintViaIframe).toHaveBeenCalledWith(expect.stringContaining('blob:'));
    expect(save).not.toHaveBeenCalled();
    // The identical artifact is still produced — same page count + byte size.
    expect(result).toMatchObject({ destination: 'print', pageCount: 1, byteSize: 2048 });
  });

  it('leaves the download path untouched — save, no auto-print, no print dispatch', async () => {
    stubImage(800, 400);
    stubObjectUrl();

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'apollo_schedule.pdf',
      destination: 'download',
    });

    expect(save).toHaveBeenCalledWith('apollo_schedule.pdf');
    expect(autoPrint).not.toHaveBeenCalled();
    expect(dispatchPrintViaIframe).not.toHaveBeenCalled();
    expect(result.destination).toBe('download');
  });

  it('defaults to the download destination when unspecified', async () => {
    stubImage(800, 400);
    const result = await exportSchedulePdf(document.createElement('div'), { fileName: 'd.pdf' });
    expect(result.destination).toBe('download');
    expect(dispatchPrintViaIframe).not.toHaveBeenCalled();
  });

  it('stamps the print destination onto a canceled result', async () => {
    stubImage(800, 400);
    const controller = new AbortController();
    controller.abort();
    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'x.pdf',
      destination: 'print',
      signal: controller.signal,
    });
    expect(result).toMatchObject({ canceled: true, destination: 'print' });
    expect(dispatchPrintViaIframe).not.toHaveBeenCalled();
  });
});

describe('scheduledPdfFileName', () => {
  it('slugifies the project name and appends the ISO day', () => {
    expect(scheduledPdfFileName('Apollo Program!', '2026-06-30T10:00:00Z')).toBe(
      'Apollo_Program_Schedule_2026-06-30.pdf',
    );
  });

  it('falls back to "Project" when the name has no slug-able characters', () => {
    expect(scheduledPdfFileName('  ***  ', '2026-01-02T00:00:00Z')).toBe(
      'Project_Schedule_2026-01-02.pdf',
    );
  });

  it('truncates a very long project name to a workable file name', () => {
    const name = 'A'.repeat(80);
    const out = scheduledPdfFileName(name, '2026-03-04T12:00:00Z');
    expect(out).toBe(`${'A'.repeat(48)}_Schedule_2026-03-04.pdf`);
  });

  it('trims the leading and trailing separators the collapse leaves behind', () => {
    expect(scheduledPdfFileName('!Apollo!', '2026-03-04')).toBe(
      'Apollo_Schedule_2026-03-04.pdf',
    );
  });
});

// ---------------------------------------------------------------------------
// Shared builders for the branch-coverage suites below
// ---------------------------------------------------------------------------

/** A DOMRect stub carrying only the fields the geometry readers touch. */
function vRect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A print surface stamped with the horizontal band geometry (CSS px). */
function bandSurface(overrides: Record<string, string> = {}): HTMLElement {
  const node = document.createElement('div');
  node.dataset.printLabelStripPx = '150'; // ×2 → 300 img px
  node.dataset.printWeekPx = '35'; // ×2 → 70 img px per week
  node.dataset.printPageWidthPx = '500'; // ×2 → 1000 img px per sheet
  for (const [key, value] of Object.entries(overrides)) {
    node.dataset[key] = value;
  }
  return node;
}

interface VflowSpec {
  /** `data-print-vmark` name → [top, bottom] in CSS px. */
  marks: Record<string, [number, number]>;
  ganttRowCount?: number;
  cpRowCount?: number;
}

/** A print surface carrying the vertical-flow markers and stamped row counts. */
function vflowSurface({ marks, ganttRowCount, cpRowCount }: VflowSpec): HTMLElement {
  const root = document.createElement('div');
  if (ganttRowCount !== undefined) root.dataset.printGanttRowCount = String(ganttRowCount);
  if (cpRowCount !== undefined) root.dataset.printCpRowCount = String(cpRowCount);
  root.getBoundingClientRect = () => vRect(0, 0);
  for (const [mark, [top, bottom]] of Object.entries(marks)) {
    const el = document.createElement('div');
    el.dataset.printVmark = mark;
    el.getBoundingClientRect = () => vRect(top, bottom);
    root.appendChild(el);
  }
  return root;
}

/** A tall single-column report: Gantt rows overflow several pages. */
function tallVflowSurface(): HTMLElement {
  return vflowSurface({
    ganttRowCount: 30,
    cpRowCount: 4,
    marks: {
      gantt: [45, 400],
      'gantt-rows': [63, 820],
      cp: [825, 900],
      'cp-list': [840, 880],
      footer: [885, 895],
    },
  });
}

/** Abort as soon as the last band/page reports progress, before the save step. */
function abortAfterLastBand(controller: AbortController) {
  return (p: ExportProgress) => {
    if (p.phase === 'paginate' && p.done === p.total) controller.abort();
  };
}

/** Captions stamped through the real text surface, in call order. */
function captions(): string[] {
  return text.mock.calls.map((c) => String(c[0]));
}

describe('exportSchedulePdf — band geometry validation (issue 1440)', () => {
  beforeEach(() => {
    stubImage(2000, 400);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });
  });

  it('bands the timeline when the surface reports a complete geometry', async () => {
    const result = await exportSchedulePdf(bandSurface(), { fileName: 'ok.pdf' });
    expect(result.pageCount).toBe(3);
  });

  it('accepts a zero week pitch and bands on the raw available width', async () => {
    const result = await exportSchedulePdf(bandSurface({ printWeekPx: '0' }), {
      fileName: 'noweek.pdf',
    });
    expect(result.pageCount).toBe(3);
  });

  const rejected: [string, Record<string, string>][] = [
    ['a missing label-strip width', { printLabelStripPx: '' }],
    ['a non-numeric label-strip width', { printLabelStripPx: 'abc' }],
    ['a zero label-strip width', { printLabelStripPx: '0' }],
    ['a missing page width', { printPageWidthPx: '' }],
    ['a zero page width', { printPageWidthPx: '0' }],
    ['a negative week pitch', { printWeekPx: '-5' }],
  ];
  for (const [label, overrides] of rejected) {
    it(`falls back to the plain single-sheet path with ${label}`, async () => {
      const result = await exportSchedulePdf(bandSurface(overrides), { fileName: 'bad.pdf' });

      expect(result.pageCount).toBe(1);
      expect(addPage).not.toHaveBeenCalled();
      expect(captions().some((c) => c.startsWith('Sheet'))).toBe(false);
      expect(save).toHaveBeenCalledWith('bad.pdf');
    });
  }

  it('never bands when the label strip is wider than the rasterized bitmap', async () => {
    // 1500 CSS px → 3000 img px, clamped to the 2000px bitmap: no chart region left.
    const result = await exportSchedulePdf(bandSurface({ printLabelStripPx: '1500' }), {
      fileName: 'clamped.pdf',
    });
    expect(result.pageCount).toBe(1);
    expect(captions().some((c) => c.startsWith('Sheet'))).toBe(false);
  });

  it('excludes the scale buffer so trailing whitespace never spills onto a sheet', async () => {
    // Content ends 200 CSS px (400 img px) past the label strip; the remaining
    // 1300 img px of the bitmap is the scale's endless-scroll buffer.
    const result = await exportSchedulePdf(bandSurface({ printChartContentPx: '200' }), {
      fileName: 'short.pdf',
    });

    expect(result.pageCount).toBe(1);
    expect(captions().some((c) => c.startsWith('Sheet'))).toBe(false);
  });

  it('treats a zero content width as unknown and bands the whole bitmap', async () => {
    const result = await exportSchedulePdf(bandSurface({ printChartContentPx: '0' }), {
      fileName: 'unknown.pdf',
    });
    expect(result.pageCount).toBe(3);
  });

  it('clamps a content width that overruns the bitmap', async () => {
    const result = await exportSchedulePdf(bandSurface({ printChartContentPx: '5000' }), {
      fileName: 'over.pdf',
    });
    expect(result.pageCount).toBe(3);
  });

});

describe('exportSchedulePdf — banding without a canvas', () => {
  it('falls through to the plain path when the band canvas has no 2D context', async () => {
    stubImage(2000, 400);
    installFakeCanvas(null);

    const result = await exportSchedulePdf(bandSurface(), { fileName: 'noctx-band.pdf' });

    expect(result.pageCount).toBe(1);
    expect(captions().some((c) => c.startsWith('Sheet'))).toBe(false);
    expect(save).toHaveBeenCalledWith('noctx-band.pdf');
  });
});

describe('exportSchedulePdf — banded sheets over multiple rows', () => {
  it('emits a column × row grid of sheets for a wide AND tall timeline', async () => {
    stubImage(2000, 1200); // 3 week-snapped columns × 2 page rows
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(bandSurface(), { fileName: 'grid.pdf' });

    expect(result.pageCount).toBe(6);
    expect(addPage).toHaveBeenCalledTimes(5);
    expect(captions()).toContain('Sheet 6 of 6');
  });

  it('still bands when the PDF surface exposes no text API', async () => {
    pdfCaps.text = false;
    stubImage(2000, 400);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(bandSurface(), { fileName: 'notext.pdf' });

    expect(result.pageCount).toBe(3);
    expect(text).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('notext.pdf');
  });

  it('discards the whole banded export when canceled after the last sheet', async () => {
    stubImage(2000, 400);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });
    const controller = new AbortController();

    const result = await exportSchedulePdf(bandSurface(), {
      fileName: 'late-cancel.pdf',
      signal: controller.signal,
      onProgress: abortAfterLastBand(controller),
    });

    expect(result).toMatchObject({ canceled: true, pageCount: 0, byteSize: 0 });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — plain bitmap banding', () => {
  it('discards the export when canceled after the last band is composited', async () => {
    stubImage(1600, 400); // 2 bands at bandWidthPx 800
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });
    const controller = new AbortController();

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'late-plain.pdf',
      bandWidthPx: 800,
      signal: controller.signal,
      onProgress: abortAfterLastBand(controller),
    });

    expect(result.canceled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('ignores a band width wider than the bitmap and emits one page', async () => {
    stubImage(800, 400);
    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'toowide.pdf',
      bandWidthPx: 5000,
    });

    expect(result.pageCount).toBe(1);
    expect(addPage).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — rasterizer failures and mid-flight cancellation', () => {
  it('rejects when the snapshot cannot be decoded', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      width = 0;
      height = 0;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);

    await expect(
      exportSchedulePdf(document.createElement('div'), { fileName: 'broken.pdf' }),
    ).rejects.toThrow('Failed to decode schedule snapshot');
    expect(save).not.toHaveBeenCalled();
  });

  it('stops right after rasterizing when the signal aborts during the snapshot', async () => {
    stubImage(800, 400);
    const controller = new AbortController();
    toPng.mockImplementation(() => {
      controller.abort();
      return Promise.resolve('data:image/png;base64,abc');
    });

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'abort-raster.pdf',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ canceled: true, pageCount: 0 });
    expect(addImage).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('stops right after decoding when the signal aborts while the image loads', async () => {
    const controller = new AbortController();
    class AbortingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      width = 800;
      height = 400;
      set src(_v: string) {
        controller.abort();
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', AbortingImage);

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'abort-decode.pdf',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ canceled: true, pageCount: 0 });
    expect(toPng).toHaveBeenCalled();
    expect(addImage).not.toHaveBeenCalled();
  });
});

describe('exportSchedulePdf — blob and destination edge cases', () => {
  beforeEach(() => {
    stubImage(800, 400);
  });

  it('reports a zero byte size when the PDF blob cannot be materialized', async () => {
    output.mockImplementation(() => {
      throw new Error('no blob in jsdom');
    });

    const result = await exportSchedulePdf(document.createElement('div'), { fileName: 'x.pdf' });

    expect(result).toMatchObject({ byteSize: 0, blobUrl: null, pageCount: 1 });
    expect(save).toHaveBeenCalledWith('x.pdf');
  });

  it('reports a zero byte size when the blob carries no size', async () => {
    output.mockImplementation(() => ({}));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:sized', revokeObjectURL: vi.fn() });

    const result = await exportSchedulePdf(document.createElement('div'), { fileName: 'x.pdf' });

    expect(result.byteSize).toBe(0);
    expect(result.blobUrl).toBe('blob:sized');
  });

  it('omits the viewer URL when object URLs are unavailable', async () => {
    vi.stubGlobal('URL', {});

    const result = await exportSchedulePdf(document.createElement('div'), { fileName: 'x.pdf' });

    expect(result.blobUrl).toBeNull();
    expect(result.byteSize).toBe(2048);
  });

  it('cannot dispatch to the printer without an object URL, and never downloads instead', async () => {
    vi.stubGlobal('URL', {});

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'x.pdf',
      destination: 'print',
    });

    expect(dispatchPrintViaIframe).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ destination: 'print', blobUrl: null, canceled: false });
  });

  it('cannot dispatch to the printer when the blob itself is unavailable', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:print', revokeObjectURL: vi.fn() });
    output.mockImplementation(() => {
      throw new Error('no blob in jsdom');
    });

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'x.pdf',
      destination: 'print',
    });

    expect(dispatchPrintViaIframe).not.toHaveBeenCalled();
    expect(result).toMatchObject({ destination: 'print', pageCount: 1, byteSize: 0 });
  });

  it('still prints when the PDF surface exposes no autoPrint action', async () => {
    pdfCaps.autoPrint = false;
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:print', revokeObjectURL: vi.fn() });

    const result = await exportSchedulePdf(document.createElement('div'), {
      fileName: 'x.pdf',
      destination: 'print',
    });

    expect(autoPrint).not.toHaveBeenCalled();
    expect(dispatchPrintViaIframe).toHaveBeenCalledWith('blob:print');
    expect(result.destination).toBe('print');
  });
});

describe('exportSchedulePdf — vertical flow geometry validation (ADR-0276)', () => {
  /** Marks for a report whose Gantt rows overflow, minus whichever mark is dropped. */
  function marksWithout(dropped: string): Record<string, [number, number]> {
    const all: Record<string, [number, number]> = {
      gantt: [45, 400],
      'gantt-rows': [63, 820],
      footer: [885, 895],
    };
    delete all[dropped];
    return all;
  }

  beforeEach(() => {
    stubImage(1000, 1800);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });
  });

  const rejected: [string, VflowSpec][] = [
    ['the Gantt marker is missing', { ganttRowCount: 30, marks: marksWithout('gantt') }],
    ['the rows marker is missing', { ganttRowCount: 30, marks: marksWithout('gantt-rows') }],
    ['the footer marker is missing', { ganttRowCount: 30, marks: marksWithout('footer') }],
    [
      'the rows region is unmeasured',
      {
        ganttRowCount: 30,
        marks: { gantt: [45, 400], 'gantt-rows': [63, 63], footer: [885, 895] },
      },
    ],
    [
      'the row count is absent',
      { marks: { gantt: [45, 400], 'gantt-rows': [63, 820], footer: [885, 895] } },
    ],
    [
      'the row count is zero',
      {
        ganttRowCount: 0,
        marks: { gantt: [45, 400], 'gantt-rows': [63, 820], footer: [885, 895] },
      },
    ],
  ];
  for (const [label, spec] of rejected) {
    it(`paginates with the plain bitmap bands when ${label}`, async () => {
      const result = await exportSchedulePdf(vflowSurface(spec), { fileName: 'plain.pdf' });

      // The plain path slices at fixed page heights and stamps no page furniture.
      expect(result.pageCount).toBeGreaterThan(1);
      expect(captions().some((c) => c.startsWith('Page '))).toBe(false);
      expect(save).toHaveBeenCalledWith('plain.pdf');
    });
  }

  it('paginates the report when the CP row count is missing', async () => {
    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 30,
        marks: {
          gantt: [45, 400],
          'gantt-rows': [63, 820],
          cp: [825, 900],
          'cp-list': [840, 880],
          footer: [885, 895],
        },
      }),
      { fileName: 'nocp.pdf' },
    );

    expect(result.pageCount).toBeGreaterThan(1);
    expect(captions()).toContain(`Page ${String(result.pageCount)} of ${String(result.pageCount)}`);
  });

  it('paginates the report when the CP list is unmeasured', async () => {
    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 30,
        cpRowCount: 4,
        marks: {
          gantt: [45, 400],
          'gantt-rows': [63, 820],
          cp: [825, 900],
          'cp-list': [840, 840],
          footer: [885, 895],
        },
      }),
      { fileName: 'flatcp.pdf' },
    );

    expect(result.pageCount).toBeGreaterThan(1);
    expect(captions().filter((c) => c === 'Critical Path Chain (Continued)')).toHaveLength(0);
  });
});

describe('exportSchedulePdf — vertical pagination behavior (ADR-0276)', () => {
  it('places the bitmap directly when the whole report fits one page', async () => {
    stubImage(1000, 600);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 3,
        marks: { gantt: [20, 60], 'gantt-rows': [30, 60], footer: [280, 295] },
      }),
      { fileName: 'short.pdf' },
    );

    expect(result.pageCount).toBe(1);
    expect(addPage).not.toHaveBeenCalled();
    // The raster is embedded as-is — no canvas round-trip, no page furniture.
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addImage.mock.calls[0][0]).toBe('data:image/png;base64,abc');
    expect(captions().some((c) => c.startsWith('Page '))).toBe(false);
  });

  it('falls back to a single oversized page when no 2D context is available', async () => {
    stubImage(1000, 1800);
    installFakeCanvas(null);

    const result = await exportSchedulePdf(tallVflowSurface(), { fileName: 'noctx-v.pdf' });

    expect(result.pageCount).toBe(1);
    expect(addPage).not.toHaveBeenCalled();
    expect(addImage.mock.calls[0][0]).toBe('data:image/png;base64,abc');
    expect(save).toHaveBeenCalledWith('noctx-v.pdf');
  });

  it('discards the report when canceled between pages', async () => {
    stubImage(1000, 1800);
    const controller = new AbortController();
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn(() => controller.abort()) });

    const result = await exportSchedulePdf(tallVflowSurface(), {
      fileName: 'cancel-v.pdf',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ canceled: true, pageCount: 0 });
    expect(save).not.toHaveBeenCalled();
  });

  it('discards the report when canceled after the last page is composited', async () => {
    stubImage(1000, 1800);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });
    const controller = new AbortController();

    const result = await exportSchedulePdf(tallVflowSurface(), {
      fileName: 'late-cancel-v.pdf',
      signal: controller.signal,
      onProgress: abortAfterLastBand(controller),
    });

    expect(result.canceled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('rules off the reserved footer band when the PDF surface can draw vectors', async () => {
    pdfCaps.line = true;
    stubImage(1000, 1800);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(tallVflowSurface(), { fileName: 'rule.pdf' });

    // One hairline per non-final page, at the reserved band's top edge (36pt up).
    expect(line).toHaveBeenCalledTimes(result.pageCount - 1);
    expect(line).toHaveBeenCalledWith(24, 595.28 - 36, 841.89 - 24, 595.28 - 36);
    expect(setDrawColor).toHaveBeenCalled();
    expect(setLineWidth).toHaveBeenCalledWith(0.5);
  });

  it('paginates without page furniture when the PDF surface exposes no text API', async () => {
    pdfCaps.text = false;
    stubImage(1000, 1760);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    // Small Gantt, long CP list → a CP continuation page, whose running header and
    // footer captions are all text-only and therefore skipped here.
    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 4,
        cpRowCount: 40,
        marks: {
          gantt: [45, 130],
          'gantt-rows': [63, 130],
          cp: [135, 850],
          'cp-list': [150, 850],
          footer: [855, 870],
        },
      }),
      { fileName: 'notext-v.pdf' },
    );

    expect(result.pageCount).toBeGreaterThan(1);
    expect(text).not.toHaveBeenCalled();
    expect(line).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('notext-v.pdf');
  });

  it('starts the unscheduled-work card on a fresh page rather than splitting it (#1799)', async () => {
    // Gantt rows end at img y 120; the keep-together card spans img y 600..1200.
    stubImage(1000, 1400);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 4,
        marks: {
          gantt: [10, 60],
          'gantt-rows': [20, 60],
          unscheduled: [300, 600],
          footer: [610, 690],
        },
      }),
      { fileName: 'unscheduled.pdf' },
    );

    const scale = 841.89 / 1000;
    expect(result.pageCount).toBe(3);
    // Page 1 runs to the card's top edge (img y 600) — the break moved down from the
    // last Gantt row so the card is not split.
    expect(addImage.mock.calls[0][5]).toBeCloseTo(600 * scale, 1);
    // Page 2 carries the whole card plus the gap to the footer (img y 600 → 1220).
    expect(addImage.mock.calls[1][5]).toBeCloseTo(620 * scale, 1);
  });

  it('breaks at the last Gantt row when the unscheduled card is unmeasured', async () => {
    stubImage(1000, 1400);
    installFakeCanvas({ clearRect: vi.fn(), drawImage: vi.fn() });

    const result = await exportSchedulePdf(
      vflowSurface({
        ganttRowCount: 4,
        marks: {
          gantt: [10, 60],
          'gantt-rows': [20, 60],
          unscheduled: [300, 300], // zero-height (never laid out) → no block
          footer: [610, 690],
        },
      }),
      { fileName: 'no-unscheduled.pdf' },
    );

    const scale = 841.89 / 1000;
    expect(result.pageCount).toBe(3);
    // Without the card's boundaries as break candidates, page 1 ends at the last
    // Gantt row (img y 120).
    expect(addImage.mock.calls[0][5]).toBeCloseTo(120 * scale, 1);
  });
});
