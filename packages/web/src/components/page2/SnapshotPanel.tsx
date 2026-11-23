import type { ReactNode } from 'react';
import { DefinitionTip } from '@/components/page2/DefinitionTip';

/** One read-only engine fact on the panel. Every string is already formatted. */
export interface SnapshotRow {
  /** The API's dotted live-diff key, e.g. `forecast.p80`. */
  id: string;
  label: string;
  /** The formatted value, or null when the server could not compute it. */
  value: string | null;
  /** The server's sentence for the figure (ADR-1314), rendered verbatim. */
  definition?: string;
  /** Why `value` is null, as a short clause ("no forecast has run"). */
  notComputable?: string;
  /**
   * Frozen mode only: the formatted CURRENT value from the API's live diff, present
   * only when the figure has moved since posting. Never computed by the client.
   */
  now?: string;
}

export interface SnapshotPanelProps {
  /** `live`: the figures that will freeze on post. `frozen`: a posted update's. */
  mode: 'live' | 'frozen';
  rows: SnapshotRow[];
  /** "as of …" for the panel, already formatted. */
  asOf?: string;
  heading?: string;
  /** Extra lines under the facts (milestones, risks), already rendered. */
  children?: ReactNode;
}

/**
 * Pass 3 snapshot panel (#4802): read-only engine facts in two modes. Live says
 * "freezes when you post"; frozen prints a "now …" tag beside any figure the API's
 * live diff says has moved since, so the posted value is never rewritten and the
 * reader still sees where the plan went. The panel formats nothing it was not given.
 */
export function SnapshotPanel({
  mode,
  rows,
  asOf,
  heading = 'Snapshot',
  children,
}: SnapshotPanelProps) {
  return (
    <section
      aria-label={heading}
      data-testid={`snapshot-panel-${mode}`}
      className="flex flex-col gap-3 rounded-lg border border-p1-hairline bg-p1-surface-2 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-p1-text-1">{heading}</h3>
        <p className="text-xs text-p1-text-2">
          {mode === 'live' ? 'Freezes when you post' : 'Frozen when posted'}
          {asOf ? ` · as of ${asOf}` : ''}
        </p>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-col" data-testid={`snapshot-row-${row.id}`}>
            <dt className="text-xs text-p1-text-2">
              <DefinitionTip term={row.label} definition={row.definition} />
            </dt>
            <dd className="flex flex-wrap items-baseline gap-x-2 text-sm text-p1-text-1">
              {row.value != null ? (
                <span className="font-mono tabular-nums">{row.value}</span>
              ) : (
                <span className="text-p1-text-2">
                  Not computable{row.notComputable ? `: ${row.notComputable}` : ''}
                </span>
              )}
              {mode === 'frozen' && row.now != null && (
                <span
                  className="rounded-full border border-p1-hairline px-2 text-xs text-p1-text-2"
                  data-testid={`snapshot-now-${row.id}`}
                >
                  now {row.now}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}
