import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportBoardPdf, boardPdfFileName } from './exportBoardPdf';

// html-to-image + jspdf are dynamically imported by the helper; mock both.
// Spies are declared via vi.hoisted so the hoisted vi.mock factories can close
// over them (a plain const would be in the temporal dead zone at mock time).
const { toPng, addImage, addPage, save, text, setFontSize, setTextColor, setLanguage, setProperties } =
  vi.hoisted(() => ({
    toPng: vi.fn(),
    addImage: vi.fn(),
    addPage: vi.fn(),
    save: vi.fn(),
    // The selectable text layer (issue 1687) exercises these; real jsPDF exposes them.
    text: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setLanguage: vi.fn(),
    setProperties: vi.fn(),
  }));
vi.mock('html-to-image', () => ({ toPng }));
vi.mock('jspdf', () => ({
  // A class so `new jsPDF()` constructs; methods delegate to the hoisted spies.
  jsPDF: class {
    addImage = addImage;
    addPage = addPage;
    save = save;
    text = text;
    setFontSize = setFontSize;
    setTextColor = setTextColor;
    setLanguage = setLanguage;
    setProperties = setProperties;
    // A4 landscape in points.
    internal = { pageSize: { getWidth: () => 841.89, getHeight: () => 595.28 } };
  },
}));

/**
 * Stub `Image` so setting `.src` resolves `loadImage` deterministically with a
 * controllable bitmap size (jsdom never fires onload for data URLs).
 */
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

beforeEach(() => {
  toPng.mockReset().mockResolvedValue('data:image/png;base64,abc');
  addImage.mockClear();
  addPage.mockClear();
  save.mockClear();
  text.mockClear();
  setFontSize.mockClear();
  setTextColor.mockClear();
  setLanguage.mockClear();
  setProperties.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exportBoardPdf', () => {
  it('rasterizes once and emits a single page when the bitmap fits one page', async () => {
    // scale = pageW/width = 841.89/800; pageImgH = pageH/scale ≈ 565 → height 400 fits.
    stubImage(800, 400);
    const node = document.createElement('div');

    await exportBoardPdf(node, { fileName: 'board-apollo-2026-06-21.pdf' });

    expect(toPng).toHaveBeenCalledWith(node, { pixelRatio: 2 });
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addPage).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('board-apollo-2026-06-21.pdf');
  });

  it('slices a tall bitmap into multiple pages', async () => {
    // height 2000 ≫ pageImgH (~565) → expect ⌈2000/565⌉-1 = 3 addPage calls.
    stubImage(800, 2000);
    // Provide a working 2D context + canvas so the slicing loop runs (jsdom's
    // canvas returns null otherwise, which would hit the single-page fallback).
    const fakeCtx = { clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
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

    const node = realCreate('div');
    await exportBoardPdf(node, { fileName: 'board-tall.pdf' });

    expect(addPage).toHaveBeenCalledTimes(3);
    expect(addImage).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenCalledWith('board-tall.pdf');
  });
});

describe('exportBoardPdf — selectable text layer (issue 1687)', () => {
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

  it('sets document metadata and stamps invisible card/column text over the raster', async () => {
    stubImage(800, 400);
    const node = document.createElement('div');
    const card = document.createElement('div');
    card.dataset.printText = 'card';
    card.textContent = 'RIV-1.3 Wire the API';
    stubRect(card, [12, 12, 180, 30]);
    node.appendChild(card);

    await exportBoardPdf(node, { fileName: 'board-apollo.pdf' });

    expect(setLanguage).toHaveBeenCalledWith('en-US');
    expect(setProperties).toHaveBeenCalledWith(expect.objectContaining({ title: 'board-apollo' }));
    expect(text).toHaveBeenCalledWith(
      'RIV-1.3 Wire the API',
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ renderingMode: 'invisible', baseline: 'top' }),
    );
  });
});

describe('boardPdfFileName', () => {
  it('slugifies the project name and appends the date', () => {
    expect(boardPdfFileName('Apollo Program!', '2026-06-21T10:00:00Z')).toBe(
      'board-apollo-program-2026-06-21.pdf',
    );
  });

  it('falls back to "board" when the name has no slug-able characters', () => {
    expect(boardPdfFileName('  ***  ', '2026-01-02T00:00:00Z')).toBe('board-board-2026-01-02.pdf');
  });
});
