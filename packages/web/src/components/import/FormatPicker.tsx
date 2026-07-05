import type { KeyboardEvent } from 'react';

/** The two import sources the create-from-import dialog can ingest (ADR-0220). */
export type ImportFormat = 'msproject' | 'trueppm';

export interface FormatPickerProps {
  /** Currently selected format. */
  format: ImportFormat;
  /** Change the selected format (clears any picked file in the host). */
  onSelectFormat: (format: ImportFormat) => void;
  /**
   * Whether the native TruePPM tile is a real choice here (ADR-0220). A native
   * seed re-imports as a whole *program*, so it is only offered in the
   * standalone create entry (no parent program). When the dialog is scoped to an
   * existing program (`programId` set), the tile stays disabled and points the
   * user at the Programs page instead.
   */
  truePpmEnabled: boolean;
  /** Whether the "how to get an .xml" guidance disclosure is expanded. */
  guidanceOpen: boolean;
  /** Toggle the guidance disclosure (the host lifts this so a dropped .mpp can auto-open it). */
  onToggleGuidance: () => void;
}

const GUIDANCE_ID = 'msproject-xml-guidance';

/** Enter/Space activates a role="radio" tile, matching native radio semantics. */
function onRadioKeyDown(event: KeyboardEvent<HTMLDivElement>, activate: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

/**
 * Format selector for the create-from-import dialog (ADR-0092, ADR-0220).
 *
 * Two ingest sources: **MS Project** (`.xml`; `.mpp`/`.mpx` are gated behind
 * issue 128 / issue 120) and **TruePPM** (the native canonical JSON seed,
 * issue 1611). Selecting TruePPM swaps the accepted file type to `.json`; the
 * host re-imports it through the program-seed importer (a native export
 * re-materializes as a whole program, ADR-0220), so the tile is only a live
 * choice in the standalone create entry — `truePpmEnabled` is false when the
 * dialog is scoped to an existing program, where the tile stays perceivable but
 * disabled with an honest reason rather than silently dimmed.
 *
 * The disabled MS Project file types (`.mpp`/`.mpx`) are likewise kept
 * perceivable — a visible "Not yet supported" badge plus a non-disabled
 * guidance disclosure explaining how to produce an `.xml` — so keyboard and
 * screen-reader users can still reach the workaround (VoC `.mpp`-friction).
 */
export function FormatPicker({
  format,
  onSelectFormat,
  truePpmEnabled,
  guidanceOpen,
  onToggleGuidance,
}: FormatPickerProps) {
  const isTruePpm = format === 'trueppm';
  const isMsProject = format === 'msproject';

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-neutral-text-secondary">Format</legend>
        <div role="radiogroup" aria-label="Import format" className="grid grid-cols-2 gap-2">
          {truePpmEnabled ? (
            <div
              role="radio"
              aria-checked={isTruePpm}
              tabIndex={0}
              onClick={() => onSelectFormat('trueppm')}
              onKeyDown={(e) => onRadioKeyDown(e, () => onSelectFormat('trueppm'))}
              className={`cursor-pointer rounded-card p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
                isTruePpm
                  ? 'border-[1.5px] border-brand-primary bg-brand-primary/5'
                  : 'border border-neutral-border bg-neutral-surface-raised'
              }`}
            >
              <p className="text-sm font-medium text-neutral-text-primary">TruePPM</p>
              <p className="mt-1 text-xs text-neutral-text-secondary">
                Native export — recreates a program
              </p>
            </div>
          ) : (
            <div
              role="radio"
              aria-checked={false}
              aria-disabled
              title="A TruePPM export is a whole program — import it from the Programs page"
              className="cursor-not-allowed rounded-card border border-neutral-border bg-neutral-surface-raised p-3 opacity-60"
            >
              <p className="text-sm font-medium text-neutral-text-primary">TruePPM</p>
              <p className="mt-1 text-xs text-neutral-text-secondary">
                Import a full export from the Programs page
              </p>
            </div>
          )}
          <div
            role="radio"
            aria-checked={isMsProject}
            tabIndex={0}
            onClick={() => onSelectFormat('msproject')}
            onKeyDown={(e) => onRadioKeyDown(e, () => onSelectFormat('msproject'))}
            className={`cursor-pointer rounded-card p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
              isMsProject
                ? 'border-[1.5px] border-brand-primary bg-brand-primary/5'
                : 'border border-neutral-border bg-neutral-surface-raised'
            }`}
          >
            <p className="text-sm font-medium text-neutral-text-primary">MS Project</p>
            <p className="mt-1 text-xs text-neutral-text-secondary">Industry-standard schedule</p>
          </div>
        </div>
      </fieldset>

      {isTruePpm ? (
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-neutral-text-secondary">File type</legend>
          <div role="radiogroup" aria-label="File type" className="flex flex-col gap-1">
            <div
              role="radio"
              aria-checked
              tabIndex={0}
              className="flex items-center justify-between rounded-card border border-neutral-border px-3 py-2
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              <span className="text-sm text-neutral-text-primary">
                <span className="font-medium">.json</span>{' '}
                <span className="text-neutral-text-secondary">Canonical TruePPM seed</span>
              </span>
              <span className="text-xs font-medium text-semantic-success">Supported</span>
            </div>
          </div>
          <p className="mt-2 rounded-card border border-neutral-border bg-neutral-surface-raised p-3 text-xs text-neutral-text-secondary">
            Export a <code>.json</code> from any TruePPM project (
            <strong>Export → JSON</strong>) or program, then upload it here. A native export
            re-imports as a <strong>program</strong> and may contain more than one project.
          </p>
        </fieldset>
      ) : (
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-neutral-text-secondary">File type</legend>
          <div role="radiogroup" aria-label="File type" className="flex flex-col gap-1">
            <div
              role="radio"
              aria-checked
              tabIndex={0}
              className="flex items-center justify-between rounded-card border border-neutral-border px-3 py-2
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              <span className="text-sm text-neutral-text-primary">
                <span className="font-medium">.xml</span>{' '}
                <span className="text-neutral-text-secondary">MS Project XML (MSPDI)</span>
              </span>
              <span className="text-xs font-medium text-semantic-success">Supported</span>
            </div>
            {(
              [
                ['.mpp', 'MS Project (binary)', 'issue 128'],
                ['.mpx', 'Legacy / ProjectLibre', 'issue 120'],
              ] as const
            ).map(([ext, label, issue]) => (
              <div
                key={ext}
                role="radio"
                aria-checked={false}
                aria-disabled
                aria-describedby={GUIDANCE_ID}
                title={`${ext} import is tracked in ${issue} (planned for 0.6)`}
                className="flex cursor-not-allowed items-center justify-between rounded-card border border-neutral-border px-3 py-2 opacity-60"
              >
                <span className="text-sm text-neutral-text-primary">
                  <span className="font-medium">{ext}</span>{' '}
                  <span className="text-neutral-text-secondary">{label}</span>
                </span>
                <span className="rounded-chip bg-neutral-surface-raised px-1.5 py-0.5 text-xs font-medium text-neutral-text-secondary">
                  Not yet supported
                </span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onToggleGuidance}
            aria-expanded={guidanceOpen}
            aria-controls={GUIDANCE_ID}
            className="mt-1 text-left text-xs font-medium text-brand-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {guidanceOpen ? '▾' : '▸'} How do I get an .xml file from MS Project?
          </button>
          <div
            id={GUIDANCE_ID}
            hidden={!guidanceOpen}
            className="mt-1 rounded-card border border-neutral-border bg-neutral-surface-raised p-3 text-xs text-neutral-text-secondary"
          >
            In MS Project (desktop): <strong>File → Save As</strong>, choose{' '}
            <strong>XML Format (*.xml)</strong>, then <strong>Save</strong>. Upload that{' '}
            <code>.xml</code> here. Project for the web can&apos;t save XML — use the desktop app.{' '}
            .mpp import is tracked in issue 128 and .mpx in issue 120 (planned for 0.6).
          </div>
        </fieldset>
      )}
    </div>
  );
}
