/**
 * Owns the schedule-export dialog's state machine and the client-side render
 * pipeline (issue 1438, ADR-0233). Keeps `ScheduleView` thin: it renders the
 * button, the dialog, and the off-screen print surface from this hook's return.
 *
 * Pure client-side (ADR-0188): no API, no dispatch. The options thread into the
 * SAME `buildSchedulePrintData` + `SchedulePrintLayout` + `exportSchedulePdf`
 * pipeline — parameters, never a divergent path.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Task, TaskLink, MonteCarloResult } from '@/types';
import { fmtUtcLong } from '@/lib/formatUtcDate';
import { buildSchedulePrintData, type SchedulePrintData } from './schedulePrintData';
import {
  exportSchedulePdf,
  scheduledPdfFileName,
  type ExportProgress,
  type ExportResult,
} from './exportSchedulePdf';
import {
  DEFAULT_EXPORT_OPTIONS,
  estimateRenderMs,
  type ScheduleExportOptions,
} from './exportOptions';

export type ExportPhase = 'configuring' | 'generating' | 'success' | 'error';

/** Inclusive ISO date window derived from the live timeline viewport. */
export interface VisibleWindow {
  start: string;
  end: string;
}

interface UseScheduleExportArgs {
  projectName: string;
  projectKey: string | null;
  workspaceUrl: string | null;
  userName: string | null;
  tasks: Task[];
  links: TaskLink[];
  forecast: MonteCarloResult | null;
  /** Snapshot the currently-visible [start,end] ISO window; null when unavailable. */
  getVisibleWindow: () => VisibleWindow | null;
  /** Whether the "Visible window" range option can be offered (engine rendered). */
  visibleWindowAvailable: boolean;
}

export interface UseScheduleExportReturn {
  open: boolean;
  canExport: boolean;
  visibleWindowAvailable: boolean;
  phase: ExportPhase;
  options: ScheduleExportOptions;
  setOption: <K extends keyof ScheduleExportOptions>(
    key: K,
    value: ScheduleExportOptions[K],
  ) => void;
  /** Post-filter activity count for the footer read-out + render estimate. */
  filteredCount: number;
  estimateMs: number;
  progress: ExportProgress | null;
  result: ExportResult | null;
  error: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  startExport: () => void;
  /** Cancel an in-flight generation (aborts between bands, nothing saved) and close. */
  cancel: () => void;
  /** "Export again…" — back to the options from success/error. */
  reset: () => void;
  openInViewer: () => void;
  // Off-screen print surface, rendered by ScheduleView only while generating.
  printSurfaceMounted: boolean;
  printRef: RefObject<HTMLDivElement | null>;
  printData: SchedulePrintData;
  printDataDate: string;
}

export function useScheduleExport(args: UseScheduleExportArgs): UseScheduleExportReturn {
  const {
    projectName,
    projectKey,
    workspaceUrl,
    userName,
    tasks,
    links,
    forecast,
    getVisibleWindow,
    visibleWindowAvailable,
  } = args;

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ExportPhase>('configuring');
  const [options, setOptions] = useState<ScheduleExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [openedAtIso, setOpenedAtIso] = useState('');
  const [visibleWindow, setVisibleWindow] = useState<VisibleWindow | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const printRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const canExport = tasks.length > 0;

  const setOption = useCallback<UseScheduleExportReturn['setOption']>((key, value) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }, []);

  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      try {
        URL.revokeObjectURL(blobUrlRef.current);
      } catch {
        /* jsdom / already revoked */
      }
      blobUrlRef.current = null;
    }
  }, []);

  const openDialog = useCallback(() => {
    if (tasks.length === 0) return;
    setOpenedAtIso(new Date().toISOString());
    setVisibleWindow(getVisibleWindow());
    // If the viewport window can't be derived, force Full so the dialog never
    // opens on an un-satisfiable "Visible window" selection.
    setOptions((prev) => ({ ...prev, range: visibleWindowAvailable ? prev.range : 'full' }));
    setProgress(null);
    setResult(null);
    setError(null);
    setPhase('configuring');
    setOpen(true);
  }, [tasks.length, getVisibleWindow, visibleWindowAvailable]);

  const closeDialog = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    revokeBlob();
    setOpen(false);
    setPhase('configuring');
    setProgress(null);
    setResult(null);
    setError(null);
  }, [revokeBlob]);

  const startExport = useCallback(() => {
    setError(null);
    setResult(null);
    setProgress({ phase: 'rasterize', done: 0, total: 1 });
    setPhase('generating');
  }, []);

  const cancel = useCallback(() => {
    // closeDialog aborts the in-flight controller; nothing reaches disk.
    closeDialog();
  }, [closeDialog]);

  const reset = useCallback(() => {
    revokeBlob();
    setResult(null);
    setError(null);
    setProgress(null);
    setPhase('configuring');
  }, [revokeBlob]);

  const openInViewer = useCallback(() => {
    if (result?.blobUrl) window.open(result.blobUrl, '_blank', 'noopener,noreferrer');
  }, [result]);

  // Revoke any lingering blob URL on unmount.
  useEffect(() => () => revokeBlob(), [revokeBlob]);

  const printDataDate = openedAtIso || '';

  const printData = useMemo(
    () =>
      buildSchedulePrintData({
        projectName: projectName || 'Schedule',
        projectKey,
        workspaceUrl,
        tasks,
        links,
        forecast,
        userName,
        generatedAtLabel: fmtUtcLong(openedAtIso || new Date().toISOString()),
        windowStart: options.range === 'visible' ? (visibleWindow?.start ?? null) : null,
        windowEnd: options.range === 'visible' ? (visibleWindow?.end ?? null) : null,
        criticalOnly: !options.includeNonCritical,
      }),
    [
      projectName,
      projectKey,
      workspaceUrl,
      tasks,
      links,
      forecast,
      userName,
      openedAtIso,
      options.range,
      options.includeNonCritical,
      visibleWindow,
    ],
  );

  const filteredCount = printData.rows.length;
  const estimateMs = estimateRenderMs(filteredCount);

  // Run the export once per entry into `generating`. Options are frozen while
  // generating (the dialog shows progress, not the form), so the captured values
  // never change under the effect and it never re-fires mid-render.
  useEffect(() => {
    if (phase !== 'generating') return undefined;
    const node = printRef.current;
    if (!node) return undefined;
    const controller = new AbortController();
    controllerRef.current = controller;
    let cancelled = false;
    void (async () => {
      try {
        const res = await exportSchedulePdf(node, {
          fileName: scheduledPdfFileName(
            projectName || 'Project',
            openedAtIso || new Date().toISOString(),
          ),
          paper: options.paper,
          signal: controller.signal,
          onProgress: (p) => {
            if (!cancelled) setProgress(p);
          },
        });
        if (cancelled || res.canceled) return;
        blobUrlRef.current = res.blobUrl;
        setResult(res);
        setPhase('success');
      } catch {
        if (!cancelled) {
          setError('RASTER_TIMEOUT');
          setPhase('error');
        }
      } finally {
        controllerRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // Options/name/date are captured intentionally at generate-start; re-running
    // on their change would restart a live export. Keyed on `phase` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return {
    open,
    canExport,
    visibleWindowAvailable,
    phase,
    options,
    setOption,
    filteredCount,
    estimateMs,
    progress,
    result,
    error,
    openDialog,
    closeDialog,
    startExport,
    cancel,
    reset,
    openInViewer,
    printSurfaceMounted: open && phase === 'generating',
    printRef,
    printData,
    printDataDate,
  };
}
