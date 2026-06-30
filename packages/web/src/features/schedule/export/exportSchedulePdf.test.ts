import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportSchedulePdf, scheduledPdfFileName, type ExportProgress } from './exportSchedulePdf';

// html-to-image + jspdf are dynamically imported by the helper; mock both. Spies
// go through vi.hoisted so the hoisted vi.mock factories can close over them.
const { toPng, addImage, addPage, save, output } = vi.hoisted(() => ({
  toPng: vi.fn(),
  addImage: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  output: vi.fn(),
}));
vi.mock('html-to-image', () => ({ toPng }));
vi.mock('jspdf', () => ({
  jsPDF: class {
    addImage = addImage;
    addPage = addPage;
    save = save;
    output = output;
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
