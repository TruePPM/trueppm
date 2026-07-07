import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportSchedulePdf, scheduledPdfFileName, type ExportProgress } from './exportSchedulePdf';

// html-to-image + jspdf are dynamically imported by the helper; mock both. Spies
// go through vi.hoisted so the hoisted vi.mock factories can close over them.
const { toPng, addImage, addPage, save, output, text, setFontSize, setTextColor } = vi.hoisted(
  () => ({
    toPng: vi.fn(),
    addImage: vi.fn(),
    addPage: vi.fn(),
    save: vi.fn(),
    output: vi.fn(),
    text: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
  }),
);
vi.mock('html-to-image', () => ({ toPng }));
vi.mock('jspdf', () => ({
  jsPDF: class {
    addImage = addImage;
    addPage = addPage;
    save = save;
    output = output;
    // Real jsPDF exposes a text layer; the banded path stamps "Sheet n of N".
    text = text;
    setFontSize = setFontSize;
    setTextColor = setTextColor;
    // A4 landscape in points; the mock ignores the `format` option.
    internal = { pageSize: { getWidth: () => 841.89, getHeight: () => 595.28 } };
  },
}));

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
});
