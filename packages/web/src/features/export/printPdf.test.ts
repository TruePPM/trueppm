// This spec deliberately invokes the stored `onload`/`onafterprint` handlers the way
// the browser would — detached from the iframe — which is exactly the pattern
// unbound-method warns about. Disable it file-wide (same as the other handler-driving
// specs, e.g. flushBoardOutbox.test.ts).
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchPrintViaIframe, PRINT_CLEANUP_FALLBACK_MS } from './printPdf';

/**
 * A fully-controlled fake `document` + iframe. jsdom neither navigates a blob-URL
 * iframe nor fires its `load`, so we drive the lifecycle by hand — the real value is
 * asserting the sequence (mount → print → cleanup), not jsdom's PDF rendering.
 */
function fakeDoc() {
  const iframe = {
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    remove: vi.fn(),
    contentWindow: null as null | {
      focus: ReturnType<typeof vi.fn>;
      print: ReturnType<typeof vi.fn>;
      onafterprint: (() => void) | null;
    },
    onload: null as null | (() => void),
    _src: '',
    get src() {
      return this._src;
    },
    set src(v: string) {
      this._src = v;
    },
  };
  const doc = {
    createElement: vi.fn(() => iframe),
    body: { appendChild: vi.fn() },
  } as unknown as Document;
  return { doc, iframe };
}

beforeEach(() => {
  vi.stubGlobal('URL', { revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dispatchPrintViaIframe (#1970)', () => {
  it('mounts a hidden, off-screen, non-display:none iframe pointed at the blob', () => {
    const { doc, iframe } = fakeDoc();
    dispatchPrintViaIframe('blob:print', doc);

    expect(doc.body.appendChild).toHaveBeenCalledWith(iframe);
    expect(iframe.src).toBe('blob:print');
    expect(iframe.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    // Off-screen but printable — a display:none iframe won't print in some browsers.
    expect(iframe.style.position).toBe('fixed');
    expect(iframe.style.display).toBeUndefined();
  });

  it('focuses and prints the iframe once it loads', () => {
    const { doc, iframe } = fakeDoc();
    const focus = vi.fn();
    const print = vi.fn();
    iframe.contentWindow = { focus, print, onafterprint: null };

    dispatchPrintViaIframe('blob:print', doc);
    iframe.onload?.();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('revokes the blob URL and removes the iframe on afterprint', () => {
    const { doc, iframe } = fakeDoc();
    iframe.contentWindow = { focus: vi.fn(), print: vi.fn(), onafterprint: null };

    dispatchPrintViaIframe('blob:print', doc);
    iframe.onload?.();
    // The OS dialog closed.
    iframe.contentWindow.onafterprint?.();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print');
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });

  it('cleans up via the fallback timer for browsers that never fire afterprint', () => {
    vi.useFakeTimers();
    const { doc, iframe } = fakeDoc();
    iframe.contentWindow = { focus: vi.fn(), print: vi.fn(), onafterprint: null };

    dispatchPrintViaIframe('blob:print', doc);
    iframe.onload?.();
    expect(iframe.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PRINT_CLEANUP_FALLBACK_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print');
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });

  it('arms the fallback at mount, so a frame that never loads is still reclaimed', () => {
    vi.useFakeTimers();
    const { doc, iframe } = fakeDoc();
    // onload never fires (blob decode failure / CSP blocks blob: frames / backgrounded).
    dispatchPrintViaIframe('blob:print', doc);
    expect(iframe.remove).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PRINT_CLEANUP_FALLBACK_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print');
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });

  it('cleanup is idempotent — afterprint then the fallback timer revoke only once', () => {
    vi.useFakeTimers();
    const { doc, iframe } = fakeDoc();
    iframe.contentWindow = { focus: vi.fn(), print: vi.fn(), onafterprint: null };

    dispatchPrintViaIframe('blob:print', doc);
    iframe.onload?.();
    iframe.contentWindow.onafterprint?.();
    vi.advanceTimersByTime(PRINT_CLEANUP_FALLBACK_MS);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });

  it('returns an idempotent cleanup the caller can invoke directly', () => {
    const { doc, iframe } = fakeDoc();
    const cleanup = dispatchPrintViaIframe('blob:print', doc);

    cleanup();
    cleanup();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });
});
