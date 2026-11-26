import type { ReactNode } from 'react';

export interface TrailEntry {
  id: string;
  /** Who did it: a name, optionally led by an `Avatar` or `NonHumanTile`. */
  who: ReactNode;
  /** When, already formatted. */
  when: string;
  /** The machine-readable instant for `<time>`. */
  dateTime?: string;
  /** The reason chip's text. */
  reason?: string;
  /** The author's words, verbatim. */
  words?: string;
  /** Already-formatted changes, e.g. "Finish 12 Mar → 19 Mar". */
  deltas?: string[];
}

export interface TrailTimelineProps {
  /** Accessible name of the list, e.g. "Baseline change trail". */
  label: string;
  entries: TrailEntry[];
}

/**
 * Pass 3 trail (#4802): who, when, reason, words and mono deltas, in the order
 * given. Entries are immutable: there is deliberately no action or edit slot.
 */
export function TrailTimeline({ label, entries }: TrailTimelineProps) {
  if (entries.length === 0) {
    return <p className="text-sm text-p1-text-2">No changes recorded yet.</p>;
  }

  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {entries.map((e) => (
        <li
          key={e.id}
          className="flex flex-col gap-1 border-l-2 border-p1-hairline-strong py-2 pl-3"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-2 font-medium text-p1-text-1">
              {e.who}
            </span>
            <time dateTime={e.dateTime} className="font-mono text-xs tabular-nums text-p1-text-2">
              {e.when}
            </time>
            {e.reason && (
              <span className="rounded-full border border-p1-hairline bg-p1-surface-2 px-2 text-xs text-p1-text-2">
                {e.reason}
              </span>
            )}
          </div>
          {e.words && <p className="text-sm text-p1-text-1">{e.words}</p>}
          {e.deltas && e.deltas.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0 font-mono text-xs tabular-nums text-p1-text-2">
              {e.deltas.map((d, i) => (
                <li key={`${i}-${d}`}>{d}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
