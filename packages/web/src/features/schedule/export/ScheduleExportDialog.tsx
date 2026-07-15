/**
 * Schedule-export options + generation dialog (issue 1438, ADR-0233).
 *
 * A hand-rolled `role="dialog" aria-modal="true"` modal (canonical recipe:
 * `useFocusTrap`, `bg-neutral-overlay` scrim + `animate-scrim-fade`, panel
 * `animate-modal-scale-in`, click-outside-to-dismiss). One modal, four states:
 * CONFIGURING → GENERATING → (SUCCESS | ERROR). It is an ACTION dialog, not an
 * edit form — closing loses nothing, so there is no dirty-guard (web-rule 217).
 *
 * Presentational: all state + the export pipeline live in `useScheduleExport`.
 */
import { useEffect } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { Button } from '@/components/Button';
import { FilePdfIcon, PrinterIcon } from '@/components/Icons';
import { Toggle } from '@/features/settings/components/Toggle';
import { ExportSegmentedField, type SegmentOption } from './ExportSegmentedField';
import {
  formatBytes,
  formatEstimate,
  formatPageCount,
  type ExportDestination,
  type ExportLayoutChoice,
  type ExportRangeChoice,
  type ScheduleExportOptions,
} from './exportOptions';
import type { ExportProgress, ExportResult, SchedulePaper } from './exportSchedulePdf';
import type { ExportPhase } from './useScheduleExport';

export interface ScheduleExportDialogProps {
  phase: ExportPhase;
  options: ScheduleExportOptions;
  setOption: <K extends keyof ScheduleExportOptions>(
    key: K,
    value: ScheduleExportOptions[K],
  ) => void;
  filteredCount: number;
  estimateMs: number;
  progress: ExportProgress | null;
  result: ExportResult | null;
  error: string | null;
  visibleWindowAvailable: boolean;
  onExport: () => void;
  onCancelGenerating: () => void;
  onReset: () => void;
  onOpenInViewer: () => void;
  onClose: () => void;
}

const DESC_ID = 'schedule-export-desc';
const LAYOUT_B_HINT_ID = 'schedule-export-layout-b-hint';

const REASSURANCE = 'Renders in your browser · nothing leaves the project';

/**
 * Discrete, non-ticking live-region text per phase (web-rule 220). Success branches
 * on destination — print announces "Print dialog opened", never "Printed", because we
 * cannot detect whether the OS dialog was completed or canceled (issue 1970).
 */
function liveMessage(phase: ExportPhase, destination: ExportDestination): string {
  switch (phase) {
    case 'generating':
      return 'Generating the PDF';
    case 'success':
      return destination === 'print' ? 'Print dialog opened' : 'PDF ready, download started';
    case 'error':
      return 'Export failed';
    default:
      return '';
  }
}

/** Visual (non-live) phase copy — may tick without flooding assistive tech. */
function phaseCopy(progress: ExportProgress | null): string {
  if (!progress || progress.phase === 'rasterize') return 'Rendering the schedule…';
  if (progress.phase === 'finalize') return 'Finishing…';
  return progress.total > 1
    ? `Placing page ${progress.done} of ${progress.total}…`
    : 'Rendering the schedule…';
}

export function ScheduleExportDialog({
  phase,
  options,
  setOption,
  filteredCount,
  estimateMs,
  progress,
  result,
  error,
  visibleWindowAvailable,
  onExport,
  onCancelGenerating,
  onReset,
  onOpenInViewer,
  onClose,
}: ScheduleExportDialogProps) {
  // Escape/scrim during generation cancels the export; otherwise it just closes.
  const dismiss = phase === 'generating' ? onCancelGenerating : onClose;
  const panelRef = useFocusTrap<HTMLDivElement>(true, dismiss);

  // Each phase swaps the whole content block, so the previously-focused control
  // (e.g. "Export PDF") unmounts and focus falls to <body> — from which the next
  // Tab would escape the still-open modal. useFocusTrap only focuses on mount, so
  // re-seat focus on the first focusable inside the panel after every transition
  // (a real focusable, not the tabIndex=-1 panel, so the trap's wrap logic holds).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, [phase, panelRef]);

  const describedBy = phase === 'configuring' || phase === 'generating' ? DESC_ID : undefined;

  const layoutOptions: SegmentOption<ExportLayoutChoice>[] = [
    { value: 'gantt', label: 'A — One-page Gantt' },
    {
      value: 'report',
      label: 'B — Report',
      disabled: true,
      title: 'Available soon — 3-page report',
      describedById: LAYOUT_B_HINT_ID,
    },
  ];
  const paperOptions: SegmentOption<SchedulePaper>[] = [
    { value: 'letter', label: 'Letter' },
    { value: 'a4', label: 'A4' },
  ];
  const rangeOptions: SegmentOption<ExportRangeChoice>[] = [
    { value: 'full', label: 'Full schedule' },
    {
      value: 'visible',
      label: 'Visible window',
      disabled: !visibleWindowAvailable,
      title: visibleWindowAvailable ? undefined : 'Available once the timeline is rendered',
    },
  ];
  const destinationOptions: SegmentOption<ExportDestination>[] = [
    { value: 'download', label: 'Download' },
    { value: 'print', label: 'Print' },
  ];

  const isPrint = options.destination === 'print';
  // `Print…` — the ellipsis signals a follow-up UI (the OS print dialog); `Download
  // PDF` is terminal so it has none. The count-gate stays on this single primary.
  const primaryActionLabel = isPrint ? 'Print…' : 'Download PDF';

  return (
    <div
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 motion-safe:animate-scrim-fade"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Export schedule"
        aria-describedby={describedBy}
        tabIndex={-1}
        className="w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-5 focus:outline-none motion-safe:animate-modal-scale-in"
      >
        {phase === 'configuring' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[15px] font-semibold text-neutral-text-primary">
                  Export schedule
                </h2>
                <p id={DESC_ID} className="mt-0.5 text-xs text-neutral-text-secondary">
                  {REASSURANCE}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close export dialog"
                className="rounded p-1 text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>

            <ExportSegmentedField
              legend="Layout"
              name="layout"
              options={layoutOptions}
              value={options.layout}
              onChange={(v) => setOption('layout', v)}
            />
            <span id={LAYOUT_B_HINT_ID} className="sr-only">
              The 3-page report layout is coming in a future release.
            </span>

            <div className="flex flex-wrap gap-6">
              <ExportSegmentedField
                legend="Paper"
                name="paper"
                options={paperOptions}
                value={options.paper}
                onChange={(v) => setOption('paper', v)}
              />
              <ExportSegmentedField
                legend="Timeline range"
                name="range"
                options={rangeOptions}
                value={options.range}
                onChange={(v) => setOption('range', v)}
              />
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
                Include
              </span>
              <div className="flex flex-col gap-2.5">
                <Toggle
                  on={options.includeArrows}
                  onChange={(v) => setOption('includeArrows', v)}
                  onLabel="Dependency arrows"
                  offLabel="Dependency arrows"
                  ariaLabel="Include dependency arrows"
                />
                <Toggle
                  on={options.includeNonCritical}
                  onChange={(v) => setOption('includeNonCritical', v)}
                  onLabel="Non-critical tasks"
                  offLabel="Non-critical tasks"
                  ariaLabel="Include non-critical tasks"
                  hint="Off charts only the critical-path chain"
                />
                <Toggle
                  on={options.includeCpSummary}
                  onChange={(v) => setOption('includeCpSummary', v)}
                  onLabel="Critical-path summary box"
                  offLabel="Critical-path summary box"
                  ariaLabel="Include the critical-path summary box"
                />
                <Toggle
                  on={options.includeOwnerColumn}
                  onChange={(v) => setOption('includeOwnerColumn', v)}
                  onLabel="Owner column"
                  offLabel="Owner column"
                  ariaLabel="Include the owner column"
                />
              </div>
            </div>

            <ExportSegmentedField
              legend="Destination"
              name="destination"
              options={destinationOptions}
              value={options.destination}
              onChange={(v) => setOption('destination', v)}
            />

            <div className="flex items-center justify-between gap-3 border-t border-neutral-border pt-3">
              <span className="text-xs text-neutral-text-secondary">
                <span className="tppm-mono text-neutral-text-primary">{filteredCount}</span>{' '}
                {filteredCount === 1 ? 'activity' : 'activities'} ·{' '}
                <span className="tppm-mono">{formatEstimate(estimateMs)}</span>
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={onExport}
                  disabled={filteredCount === 0}
                  title={filteredCount === 0 ? 'Nothing to export with these options' : undefined}
                >
                  {primaryActionLabel}
                </Button>
              </div>
            </div>
          </div>
        )}

        {phase === 'generating' && (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <h2 className="text-[15px] font-semibold text-neutral-text-primary">
              Exporting schedule
            </h2>
            <span
              aria-hidden="true"
              className="h-6 w-6 rounded-full border-2 border-neutral-border border-t-brand-primary motion-safe:animate-spin"
            />
            <p className="text-sm text-neutral-text-primary">{phaseCopy(progress)}</p>
            <div className="w-full">
              <div
                role="progressbar"
                aria-label="Export progress"
                aria-valuemin={0}
                aria-valuemax={progress?.total ?? 1}
                aria-valuenow={progress?.done ?? 0}
                className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-surface-sunken"
              >
                <div
                  className="h-full rounded-full bg-brand-primary transition-[width] duration-200 ease-brand"
                  style={{
                    width: `${
                      progress && progress.total > 0
                        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
            <p id={DESC_ID} className="text-xs text-neutral-text-secondary">
              {REASSURANCE}
            </p>
            <Button variant="ghost" onClick={onCancelGenerating}>
              Cancel
            </Button>
          </div>
        )}

        {phase === 'success' && result && (
          <div className="flex flex-col gap-4">
            <h2 className="text-[15px] font-semibold text-neutral-text-primary">
              <span aria-hidden="true" className="text-semantic-on-track">
                ✓
              </span>{' '}
              {result.destination === 'print'
                ? 'Print dialog opened'
                : 'PDF ready · download started'}
            </h2>
            <div className="flex items-center gap-3 rounded-md border border-neutral-border bg-neutral-surface-sunken p-3">
              {result.destination === 'print' ? (
                <>
                  <PrinterIcon
                    className="h-5 w-5 shrink-0 text-neutral-text-secondary"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="text-[13px] text-neutral-text-primary">
                      Sent to your printer
                    </div>
                    <div className="tppm-mono text-xs text-neutral-text-secondary">
                      {formatPageCount(result.pageCount)} ·{' '}
                      {result.paper === 'a4' ? 'A4' : 'Letter'}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <FilePdfIcon
                    className="h-5 w-5 shrink-0 text-neutral-text-secondary"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div
                      className="tppm-mono truncate text-[13px] text-neutral-text-primary"
                      title={result.fileName}
                    >
                      {result.fileName}
                    </div>
                    <div className="tppm-mono text-xs text-neutral-text-secondary">
                      {formatPageCount(result.pageCount)} ·{' '}
                      {result.paper === 'a4' ? 'A4' : 'Letter'} · {formatBytes(result.byteSize)}
                    </div>
                  </div>
                </>
              )}
            </div>
            {result.destination === 'print' && result.blobUrl && (
              // Gated on blobUrl so the sentence and the "Open printable PDF" button
              // (also blobUrl-gated) always appear together — never point at an absent
              // control (issue 1970).
              <p className="text-xs text-neutral-text-secondary">
                Didn&rsquo;t see the print dialog? Open the printable PDF and print from there.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" onClick={onReset}>
                Export again…
              </Button>
              <div className="flex gap-2">
                {result.blobUrl && (
                  <Button variant="ghost" onClick={onOpenInViewer}>
                    {result.destination === 'print' ? 'Open printable PDF' : 'Open in viewer'}
                  </Button>
                )}
                <Button variant="primary" onClick={onClose}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col gap-4">
            <h2 role="alert" className="text-[15px] font-semibold text-neutral-text-primary">
              <span aria-hidden="true" className="text-semantic-critical">
                ⚠
              </span>{' '}
              Couldn&rsquo;t generate the PDF
            </h2>
            <p className="text-sm text-neutral-text-secondary">
              The schedule may be too large to render in one pass. Try again, or narrow the timeline
              range and hide non-critical tasks.
            </p>
            {error && (
              <p className="tppm-mono text-xs text-neutral-text-secondary">code: {error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={onReset}>
                Try again
              </Button>
            </div>
          </div>
        )}

        <span className="sr-only" role="status" aria-live="polite">
          {liveMessage(phase, result?.destination ?? options.destination)}
        </span>
      </div>
    </div>
  );
}
