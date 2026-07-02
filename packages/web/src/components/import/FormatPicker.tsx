export interface FormatPickerProps {
  /** Whether the "how to get an .xml" guidance disclosure is expanded. */
  guidanceOpen: boolean;
  /** Toggle the guidance disclosure (the host lifts this so a dropped .mpp can auto-open it). */
  onToggleGuidance: () => void;
}

const GUIDANCE_ID = 'msproject-xml-guidance';

/**
 * Format selector for the create-from-import dialog (ADR-0092).
 *
 * Pure client-side gating: it advertises what TruePPM can ingest today rather
 * than offering a real choice. "TruePPM" is shown disabled ("coming soon") and
 * MS Project is the selected format; under it `.xml` is enabled while
 * `.mpp`/`.mpx` are disabled (backend support tracked in #128/#120). The
 * disabled file types are kept perceivable — a visible "Not yet supported"
 * badge and a non-disabled guidance disclosure explaining how to produce an
 * `.xml` from MS Project — rather than silently dimmed, so keyboard and
 * screen-reader users can still reach the workaround (VoC `.mpp`-friction 🟡).
 */
export function FormatPicker({ guidanceOpen, onToggleGuidance }: FormatPickerProps) {
  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-neutral-text-secondary">Format</legend>
        <div role="radiogroup" aria-label="Import format" className="grid grid-cols-2 gap-2">
          <div
            role="radio"
            aria-checked={false}
            aria-disabled
            className="cursor-not-allowed rounded-card border border-neutral-border bg-neutral-surface-raised p-3 opacity-60"
          >
            <p className="text-sm font-medium text-neutral-text-primary">TruePPM</p>
            <span className="mt-1 inline-block rounded-chip bg-neutral-surface px-1.5 py-0.5 text-xs font-medium text-neutral-text-secondary">
              Coming soon
            </span>
          </div>
          <div
            role="radio"
            aria-checked
            tabIndex={0}
            className="rounded-card border-[1.5px] border-brand-primary bg-brand-primary/5 p-3
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            <p className="text-sm font-medium text-neutral-text-primary">MS Project</p>
            <p className="mt-1 text-xs text-neutral-text-secondary">Industry-standard schedule</p>
          </div>
        </div>
      </fieldset>

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
              ['.mpp', 'MS Project (binary)'],
              ['.mpx', 'Legacy / ProjectLibre'],
            ] as const
          ).map(([ext, label]) => (
            <div
              key={ext}
              role="radio"
              aria-checked={false}
              aria-disabled
              aria-describedby={GUIDANCE_ID}
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
          <code>.xml</code> here. Project for the web can&apos;t save XML — use the desktop app.
        </div>
      </fieldset>
    </div>
  );
}
