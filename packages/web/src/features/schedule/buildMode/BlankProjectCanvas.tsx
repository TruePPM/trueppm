import { useMemo } from 'react';

export interface BlankProjectFacts {
  /** ISO date the project starts — the horizon's left edge. */
  startDate?: string | null;
  /** Calendar name the horizon is drawn against. */
  calendarName?: string | null;
  /** Default delivery mode, as the Start sheet recorded it. */
  defaultMode?: string | null;
  /** Views this project's methodology makes available. */
  views?: string[];
}

export interface BlankProjectCanvasProps {
  facts: BlankProjectFacts;
  /** Omitted for read-only roles — the fill options all write. */
  onPasteRows?: () => void;
  onImportFile?: () => void;
  onApplyTemplate?: () => void;
}

/** Weeks of horizon to draw. Enough to read as a plan surface, not so much that the
 *  ruler implies a commitment nobody has made. */
const HORIZON_WEEKS = 12;

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  // Monday-based: the horizon is a working ruler, and a week that starts on Sunday
  // puts two non-working days at its head for most of the calendars we ship.
  const day = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - day);
  return out;
}

/**
 * The right half of a blank project's Schedule (#2733).
 *
 * Replaces the "No tasks yet" card with two things a card cannot be: a **horizon**
 * drawn against the project's own calendar, so an empty project looks like a plan
 * surface rather than a failure; and a **quiet** side panel of the other ways to
 * fill it.
 *
 * Quiet is a requirement, not a style note. The fill options compete with the live
 * row in the outline, which is the path most people should take — so they are
 * offered at the edge, at secondary weight, and none of them is a primary button.
 * The moment this panel shouts, it has pulled the user out of the canvas the rest
 * of the change exists to put them in.
 */
export function BlankProjectCanvas({
  facts,
  onPasteRows,
  onImportFile,
  onApplyTemplate,
}: BlankProjectCanvasProps) {
  const weeks = useMemo(() => {
    const anchor = facts.startDate ? new Date(`${facts.startDate}T00:00:00`) : new Date();
    const first = startOfWeek(Number.isNaN(anchor.getTime()) ? new Date() : anchor);
    return Array.from({ length: HORIZON_WEEKS }, (_, i) => {
      const d = new Date(first);
      d.setDate(d.getDate() + i * 7);
      return d;
    });
  }, [facts.startDate]);

  const canFill = [onPasteRows, onImportFile, onApplyTemplate].some(Boolean);

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      {/* Horizon — a real ruler against the chosen calendar, deliberately with no
          bars on it. An empty grid says "nothing is planned yet"; a blank panel
          says "something is broken". */}
      <div className="flex-1 min-w-0 overflow-x-auto" aria-hidden="true">
        <div className="flex border-b border-neutral-border min-w-max">
          {weeks.map((w) => (
            <div
              key={w.toISOString()}
              className="w-24 flex-shrink-0 border-r border-neutral-border/60 px-2 py-1
                text-xs text-neutral-text-secondary"
            >
              {w.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </div>
          ))}
        </div>
        <div className="flex min-w-max h-full">
          {weeks.map((w) => (
            <div
              key={w.toISOString()}
              className="w-24 flex-shrink-0 border-r border-neutral-border/30"
            />
          ))}
        </div>
      </div>

      <aside
        aria-label="Ways to fill this project"
        className="w-64 flex-shrink-0 border-l border-neutral-border bg-neutral-surface
          overflow-y-auto p-4 flex flex-col gap-5"
      >
        {canFill && (
          <div className="flex flex-col gap-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
              Other ways to fill it
            </h2>
            {onPasteRows && <FillOption label="Paste rows" onClick={onPasteRows} />}
            {onImportFile && <FillOption label="Import a file" onClick={onImportFile} />}
            {onApplyTemplate && <FillOption label="Apply a template" onClick={onApplyTemplate} />}
          </div>
        )}

        {/* The project's stated facts, so the horizon above is legible: a ruler
            with no named calendar behind it is just gridlines. */}
        <div className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            This project
          </h2>
          <dl className="flex flex-col gap-1 text-xs">
            <Fact label="Starts" value={facts.startDate ?? '—'} />
            <Fact label="Calendar" value={facts.calendarName ?? '—'} />
            <Fact label="Default mode" value={facts.defaultMode ?? '—'} />
            <Fact
              label="Views"
              value={facts.views && facts.views.length > 0 ? facts.views.join(', ') : '—'}
            />
          </dl>
        </div>
      </aside>
    </div>
  );
}

function FillOption({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left text-sm text-brand-primary hover:underline rounded-control
        focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
    >
      {label}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-text-secondary">{label}</dt>
      <dd className="text-neutral-text-primary text-right">{value}</dd>
    </div>
  );
}
