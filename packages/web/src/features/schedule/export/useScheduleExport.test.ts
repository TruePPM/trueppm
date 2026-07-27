import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render } from '@testing-library/react';
import { createElement } from 'react';
import { useScheduleExport, type VisibleWindow } from './useScheduleExport';
import type {
  ExportProgress,
  ExportResult,
  ExportSchedulePdfOptions,
} from './exportSchedulePdf';
import type { Task, TaskLink } from '@/types';

// The rasterize pipeline is exercised by exportSchedulePdf's own spec; here it is
// a seam so the hook's generate → success / cancel / error state machine can be
// driven deterministically.
const exportMock =
  vi.fn<(node: HTMLElement, opts: ExportSchedulePdfOptions) => Promise<ExportResult>>();
const fileNameMock = vi.fn<(projectName: string, isoDate: string) => string>();

vi.mock('./exportSchedulePdf', () => ({
  exportSchedulePdf: (node: HTMLElement, opts: ExportSchedulePdfOptions) => exportMock(node, opts),
  scheduledPdfFileName: (projectName: string, isoDate: string) =>
    fileNameMock(projectName, isoDate),
}));

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

// Task A is critical and early; Task B is non-critical and late.
const A = task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-08', isCritical: true });
const B = task('b', { wbs: '2', start: '2026-04-20', finish: '2026-04-30', isCritical: false });

function makeArgs(overrides: Partial<Parameters<typeof useScheduleExport>[0]> = {}) {
  return {
    projectName: 'Apollo',
    projectKey: null,
    workspaceUrl: null,
    userName: 'Jane',
    tasks: [A, B] as Task[],
    links: [] as TaskLink[],
    forecast: null,
    getVisibleWindow: (): VisibleWindow | null => ({ start: '2026-04-18', end: '2026-05-01' }),
    visibleWindowAvailable: true,
    ...overrides,
  };
}

type ExportArgs = Parameters<typeof useScheduleExport>[0];
type ExportApi = ReturnType<typeof useScheduleExport>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pdfResult(overrides: Partial<ExportResult> = {}): ExportResult {
  return {
    fileName: 'Apollo_Schedule_2026-04-01.pdf',
    pageCount: 3,
    paper: 'letter',
    destination: 'download',
    byteSize: 4096,
    canceled: false,
    blobUrl: 'blob:apollo',
    ...overrides,
  };
}

/**
 * Mount the hook on a host that attaches `printRef`, so the generate effect sees a
 * live print surface (a bare `renderHook` leaves the ref null and the effect bails).
 * Pass `attachRef: false` to reproduce the "surface not mounted yet" case.
 */
function mountExport(args: ExportArgs, attachRef = true) {
  const api: { current: ExportApi } = { current: null as unknown as ExportApi };
  function Host() {
    const value = useScheduleExport(args);
    api.current = value;
    return createElement('div', attachRef ? { ref: value.printRef } : {});
  }
  const utils = render(createElement(Host));
  return { api, ...utils };
}

/** Let queued microtasks (the effect's async IIFE) settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  exportMock.mockReset();
  fileNameMock.mockReset();
  fileNameMock.mockImplementation((p, d) => `${p}_Schedule_${d.slice(0, 10)}.pdf`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScheduleExport', () => {
  it('canExport reflects task count and openDialog is a no-op when empty', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs({ tasks: [] })));
    expect(result.current.canExport).toBe(false);
    act(() => result.current.openDialog());
    expect(result.current.open).toBe(false);
  });

  it('openDialog opens the configuring state', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    expect(result.current.open).toBe(true);
    expect(result.current.phase).toBe('configuring');
  });

  it('filteredCount defaults to critical-only, then reflects toggling non-critical on', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    // Default includeNonCritical=false → only the critical row A is charted.
    expect(result.current.filteredCount).toBe(1);
    act(() => result.current.setOption('includeNonCritical', true));
    expect(result.current.filteredCount).toBe(2);
  });

  it('the visible-window range clips the charted rows to the snapshot window', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.setOption('includeNonCritical', true));
    act(() => result.current.setOption('range', 'visible'));
    // Window 04-18..05-01 excludes A (Apr 1–8) and includes B (Apr 20–30).
    expect(result.current.filteredCount).toBe(1);
  });

  it('coerces range to full when the visible window is unavailable', () => {
    const { result } = renderHook(() =>
      useScheduleExport(makeArgs({ visibleWindowAvailable: false })),
    );
    act(() => {
      result.current.setOption('range', 'visible');
    });
    act(() => result.current.openDialog());
    expect(result.current.options.range).toBe('full');
  });

  it('startExport enters the generating state; closeDialog resets to configuring and closes', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.startExport());
    expect(result.current.phase).toBe('generating');
    act(() => result.current.closeDialog());
    expect(result.current.open).toBe(false);
    expect(result.current.phase).toBe('configuring');
  });

  it('reset returns to configuring and clears any prior error/result', () => {
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    act(() => result.current.openDialog());
    act(() => result.current.reset());
    expect(result.current.phase).toBe('configuring');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('openInViewer opens the result blob URL in a new tab', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useScheduleExport(makeArgs()));
    // No result yet → openInViewer is a no-op.
    act(() => result.current.openInViewer());
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('the print surface is mounted only while generating', () => {
    const { api } = mountExport(makeArgs());
    expect(api.current.printSurfaceMounted).toBe(false);
    act(() => api.current.openDialog());
    expect(api.current.printSurfaceMounted).toBe(false);
    act(() => api.current.startExport());
    expect(api.current.printSurfaceMounted).toBe(true);
  });

  it('does not run the pipeline while the print surface is unmounted', async () => {
    const { api } = mountExport(makeArgs(), false);
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();
    expect(exportMock).not.toHaveBeenCalled();
    expect(api.current.phase).toBe('generating');
  });

  // -------------------------------------------------------------------------
  // Generate → success
  // -------------------------------------------------------------------------

  it('generates, reports progress, and lands on success with the finished result', async () => {
    const pending = deferred<ExportResult>();
    let report: ((p: ExportProgress) => void) | undefined;
    exportMock.mockImplementation((_node, opts) => {
      report = opts.onProgress;
      return pending.promise;
    });

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.setOption('paper', 'a4'));
    act(() => api.current.setOption('destination', 'print'));
    act(() => api.current.startExport());
    // startExport seeds an indeterminate first tick.
    expect(api.current.progress).toEqual({ phase: 'rasterize', done: 0, total: 1 });

    const [node, opts] = exportMock.mock.calls[0];
    expect(node).toBeInstanceOf(HTMLElement);
    expect(opts.paper).toBe('a4');
    expect(opts.destination).toBe('print');
    expect(opts.fileName).toMatch(/^Apollo_Schedule_\d{4}-\d{2}-\d{2}\.pdf$/);
    // The file name is stamped from the dialog-open instant, not "now at save".
    expect(fileNameMock).toHaveBeenCalledWith(
      'Apollo',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );

    act(() => report?.({ phase: 'paginate', done: 2, total: 5 }));
    expect(api.current.progress).toEqual({ phase: 'paginate', done: 2, total: 5 });

    await act(async () => {
      pending.resolve(pdfResult({ pageCount: 5 }));
      await pending.promise;
    });
    expect(api.current.phase).toBe('success');
    expect(api.current.result?.pageCount).toBe(5);
    expect(api.current.error).toBeNull();
    expect(api.current.printSurfaceMounted).toBe(false);
  });

  it('openInViewer opens the finished blob and closeDialog revokes it', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    exportMock.mockResolvedValue(pdfResult({ blobUrl: 'blob:the-pdf' }));

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();
    expect(api.current.phase).toBe('success');

    act(() => api.current.openInViewer());
    expect(openSpy).toHaveBeenCalledWith('blob:the-pdf', '_blank', 'noopener,noreferrer');

    act(() => api.current.closeDialog());
    expect(revokeSpy).toHaveBeenCalledWith('blob:the-pdf');
    expect(api.current.open).toBe(false);
    expect(api.current.result).toBeNull();
  });

  it('reset revokes the finished blob and returns to the options form', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    exportMock.mockResolvedValue(pdfResult({ blobUrl: 'blob:again' }));

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();

    act(() => api.current.reset());
    expect(revokeSpy).toHaveBeenCalledWith('blob:again');
    expect(api.current.phase).toBe('configuring');
    expect(api.current.result).toBeNull();
    expect(api.current.progress).toBeNull();
    // Still open — "Export again…" returns to the form, it does not dismiss.
    expect(api.current.open).toBe(true);
  });

  it('survives a revoke that throws (already-revoked / unsupported URL)', async () => {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      throw new Error('not implemented');
    });
    exportMock.mockResolvedValue(pdfResult({ blobUrl: 'blob:doomed' }));

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();

    expect(() => act(() => api.current.closeDialog())).not.toThrow();
    expect(api.current.open).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Generate → canceled / error
  // -------------------------------------------------------------------------

  it('a canceled render leaves the dialog generating with nothing saved', async () => {
    exportMock.mockResolvedValue(pdfResult({ canceled: true, blobUrl: null, pageCount: 0 }));

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();

    expect(api.current.result).toBeNull();
    expect(api.current.phase).toBe('generating');
    expect(api.current.error).toBeNull();
  });

  it('a failed render surfaces the machine code and the error phase', async () => {
    exportMock.mockRejectedValue(new Error('raster timed out'));

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    await flush();

    expect(api.current.phase).toBe('error');
    expect(api.current.error).toBe('RASTER_TIMEOUT');
    expect(api.current.result).toBeNull();
  });

  it('cancel aborts the in-flight render and a late success is discarded', async () => {
    const pending = deferred<ExportResult>();
    let report: ((p: ExportProgress) => void) | undefined;
    let signal: AbortSignal | undefined;
    exportMock.mockImplementation((_node, opts) => {
      report = opts.onProgress;
      signal = opts.signal;
      return pending.promise;
    });

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    expect(signal?.aborted).toBe(false);

    act(() => api.current.cancel());
    expect(signal?.aborted).toBe(true);
    expect(api.current.open).toBe(false);
    expect(api.current.phase).toBe('configuring');

    // Progress and the eventual result from the abandoned run must not land.
    act(() => report?.({ phase: 'paginate', done: 9, total: 9 }));
    expect(api.current.progress).toBeNull();

    await act(async () => {
      pending.resolve(pdfResult());
      await pending.promise;
    });
    expect(api.current.result).toBeNull();
    expect(api.current.phase).toBe('configuring');
  });

  it('a late failure from a canceled render does not raise an error banner', async () => {
    const pending = deferred<ExportResult>();
    exportMock.mockImplementation(() => pending.promise);

    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    act(() => api.current.startExport());
    act(() => api.current.cancel());

    await act(async () => {
      pending.reject(new Error('too late'));
      await pending.promise.catch(() => undefined);
    });
    expect(api.current.error).toBeNull();
    expect(api.current.phase).toBe('configuring');
  });

  // -------------------------------------------------------------------------
  // Fallbacks for a missing project name / un-opened dialog
  // -------------------------------------------------------------------------

  it('falls back to placeholder naming for an unnamed project and an un-opened dialog', async () => {
    exportMock.mockResolvedValue(pdfResult());
    // Export triggered without openDialog → no captured instant; project has no name.
    const { api } = mountExport(makeArgs({ projectName: '' }));
    expect(api.current.printDataDate).toBe('');
    expect(api.current.printData.masthead.projectName).toBe('Schedule');

    act(() => api.current.startExport());
    await flush();

    expect(fileNameMock).toHaveBeenCalledWith(
      'Project',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('records the dialog-open instant as the print data date', () => {
    const { api } = mountExport(makeArgs());
    act(() => api.current.openDialog());
    expect(api.current.printDataDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a visible range with no derivable window charts the full schedule', () => {
    const { api } = mountExport(makeArgs({ getVisibleWindow: () => null }));
    act(() => api.current.openDialog());
    act(() => api.current.setOption('includeNonCritical', true));
    act(() => api.current.setOption('range', 'visible'));
    // No window snapshot → no clipping, so both activities still chart.
    expect(api.current.filteredCount).toBe(2);
  });

  it('seeds the arrow toggle from the in-app chart menu, and keeps the default without it', () => {
    const seeded = mountExport(makeArgs({ initialArrows: false }));
    act(() => seeded.api.current.openDialog());
    expect(seeded.api.current.options.includeArrows).toBe(false);

    const plain = mountExport(makeArgs());
    act(() => plain.api.current.openDialog());
    expect(plain.api.current.options.includeArrows).toBe(true);
  });
});
