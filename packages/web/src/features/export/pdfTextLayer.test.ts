import { describe, it, expect, vi } from 'vitest';
import {
  collectPrintTextRuns,
  setPrintDocumentMetadata,
  stampTextLayerForPage,
  type PrintTextRun,
} from './pdfTextLayer';

/** Give an element a fixed bounding box (jsdom returns all-zeros by default). */
function stubRect(el: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('collectPrintTextRuns', () => {
  it('collects marked runs in document order with root-relative CSS-px boxes', () => {
    const root = document.createElement('div');
    stubRect(root, { left: 100, top: 50, width: 800, height: 600 });

    const kpi = document.createElement('div');
    kpi.dataset.printText = 'kpi';
    kpi.textContent = 'Duration  120d'; // collapses to single spaces
    stubRect(kpi, { left: 120, top: 70, width: 90, height: 40 });
    root.appendChild(kpi);

    const row = document.createElement('div');
    row.dataset.printText = 'row';
    row.textContent = '1.2 Design';
    stubRect(row, { left: 110, top: 200, width: 260, height: 22 });
    root.appendChild(row);

    const runs = collectPrintTextRuns(root);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ role: 'kpi', text: 'Duration 120d', left: 20, top: 20 });
    expect(runs[1]).toMatchObject({ role: 'row', text: '1.2 Design', left: 10, top: 150 });
  });

  it('skips empty-text and zero-area (unmeasured) elements', () => {
    const root = document.createElement('div');
    stubRect(root, { left: 0, top: 0, width: 800, height: 600 });

    const empty = document.createElement('div');
    empty.dataset.printText = 'row';
    empty.textContent = '   ';
    stubRect(empty, { left: 0, top: 0, width: 200, height: 22 });
    root.appendChild(empty);

    // Marked but never laid out (jsdom default zeros) → skipped.
    const degenerate = document.createElement('div');
    degenerate.dataset.printText = 'row';
    degenerate.textContent = 'has text but no layout';
    root.appendChild(degenerate);

    expect(collectPrintTextRuns(root)).toHaveLength(0);
  });
});

describe('stampTextLayerForPage', () => {
  const runs: PrintTextRun[] = [
    { text: 'Row A', left: 10, top: 10, width: 100, height: 20, role: 'row' }, // img: 20,20..220,60
    { text: 'Row B', left: 10, top: 200, width: 100, height: 20, role: 'row' }, // img: 20,400..220,440
  ];

  it('stamps only the runs intersecting the page source region, re-projected to points', () => {
    const text = vi.fn();
    const pdf = { text, setFontSize: vi.fn(), setTextColor: vi.fn() };

    // Page shows source y 0..300 (img px) at scale 0.5, dest origin (0, 30pt).
    stampTextLayerForPage(pdf, runs, 2, {
      srcX: 0,
      srcY: 0,
      srcW: 500,
      srcH: 300,
      destX: 0,
      destY: 30,
      scale: 0.5,
    });

    // Only Row A (img top 20 ∈ [0,300)) is stamped; Row B (img top 400) is off-page.
    expect(text).toHaveBeenCalledTimes(1);
    const [str, x, y, opts] = text.mock.calls[0] as [string, number, number, Record<string, unknown>];
    expect(str).toBe('Row A');
    // x = destX + (ix - srcX)*scale = 0 + 20*0.5 = 10; y = 30 + 20*0.5 = 40.
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(40);
    expect(opts).toMatchObject({ renderingMode: 'invisible', baseline: 'top' });
  });

  it('offsets the second page so the continuation run lands at the page top', () => {
    const text = vi.fn();
    const pdf = { text, setFontSize: vi.fn(), setTextColor: vi.fn() };

    // Page 2 shows source y 300..600; Row B (img top 400) maps to (400-300)*0.5 = 50pt.
    stampTextLayerForPage(pdf, runs, 2, {
      srcX: 0,
      srcY: 300,
      srcW: 500,
      srcH: 300,
      destX: 0,
      destY: 0,
      scale: 0.5,
    });

    expect(text).toHaveBeenCalledTimes(1);
    const [str, , y] = text.mock.calls[0] as [string, number, number, Record<string, unknown>];
    expect(str).toBe('Row B');
    expect(y).toBeCloseTo(50);
  });

  it('is a no-op when the jsPDF surface does not expose text (test double safety)', () => {
    const pdf = { addImage: vi.fn() }; // no `.text`
    expect(() =>
      stampTextLayerForPage(pdf, runs, 2, {
        srcX: 0,
        srcY: 0,
        srcW: 500,
        srcH: 600,
        destX: 0,
        destY: 0,
        scale: 1,
      }),
    ).not.toThrow();
  });
});

describe('setPrintDocumentMetadata', () => {
  it('sets the document title and language when the surface supports it', () => {
    const setProperties = vi.fn();
    const setLanguage = vi.fn();
    setPrintDocumentMetadata({ setProperties, setLanguage }, { title: 'Apollo_Schedule_2026-07-09' });
    expect(setLanguage).toHaveBeenCalledWith('en-US');
    expect(setProperties).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Apollo_Schedule_2026-07-09' }),
    );
  });

  it('is a no-op on a surface without metadata setters', () => {
    expect(() => setPrintDocumentMetadata({}, { title: 'x' })).not.toThrow();
  });
});
