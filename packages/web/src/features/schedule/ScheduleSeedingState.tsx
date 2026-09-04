/**
 * Shown instead of the blank-project canvas (desktop) or the "No items yet" card
 * (mobile) while a just-applied template's rows are still being written (#3312).
 *
 * Applying a template is asynchronous: the Start sheet fires the apply and
 * navigates immediately without waiting for it (ADR-0789 §4 — never block on
 * seeding), landing on `/projects/{id}/schedule?templateApplication={id}`. The
 * seed banner deliberately renders nothing until the application reports
 * `success` — it summarizes a finished apply, it is not a progress bar — and
 * nothing else keyed off the pending application. So the gap between landing and
 * the rows arriving showed the project's ORDINARY empty state: on desktop a live
 * draft row with the caret already in it, inviting the user to type a first item
 * into a project a template is mid-write on; on mobile "No items yet", which
 * reads as "the apply failed".
 *
 * This is the Schedule counterpart of `BacklogSeedingState`, which the AGILE
 * route has had since #2734 — the same wait, one route over, now with the same
 * affordance. Like it, this is a pure skeleton with no polling of its own: the
 * moment the first seeded row arrives over the board WebSocket the project is no
 * longer empty and `ScheduleView` stops rendering this.
 */

/**
 * Offsets and widths as percentages of the canvas.
 *
 * Staggered rather than uniform on purpose: the surface these bars stand in for
 * is a bar track, and six identical full-width blocks read as a list, setting the
 * wrong expectation for what is about to appear. Six is enough to read as a plan
 * taking shape and few enough not to imply a row count the template may not match.
 */
const SEEDING_BARS = [
  { offset: 0, width: 44 },
  { offset: 10, width: 28 },
  { offset: 16, width: 34 },
  { offset: 38, width: 22 },
  { offset: 30, width: 40 },
  { offset: 58, width: 18 },
] as const;

/** Widths for the outline's stand-in rows — narrower, since they stand in for names. */
const SEEDING_OUTLINE_WIDTHS = [62, 44, 71, 38, 55, 48] as const;

/**
 * The canvas half of the seeding state — desktop bar track and mobile body alike.
 *
 * One component for both because percentage-width bars flex to either container
 * and there is no layout difference that would justify a second file.
 *
 * This is the screen's ONLY `role="status"` while seeding: `ScheduleSeedingOutlineRows`
 * beside it is `aria-hidden`, so a screen reader hears the sentence once rather
 * than two live regions announcing the same wait.
 */
export function ScheduleSeedingState() {
  return (
    <div
      // `aria-label` rather than an implicit name: accname trims and concatenates
      // text nodes, so the derived name here would be both paragraphs run together.
      role="status"
      aria-label="Setting up your schedule"
      data-testid="schedule-seeding-state"
      className="flex flex-1 min-w-0 flex-col gap-2 overflow-hidden bg-neutral-surface p-6"
    >
      <p className="text-[13px] text-neutral-text-secondary">Setting up your schedule…</p>
      {/* Names the cause and the resolution. The blank canvas this replaces said
          neither, which is why the wait read as "nothing happened". No spinner,
          percentage or ETA: the server publishes no progress and a fabricated one
          would be a control that lies. */}
      <p className="mb-2 text-xs text-neutral-text-secondary">
        Writing rows from your template. They&rsquo;ll appear as they land.
      </p>
      {SEEDING_BARS.map((bar, i) => (
        <div key={i} className="h-8">
          <div
            aria-hidden="true"
            className="h-full rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse"
            style={{ marginLeft: `${bar.offset}%`, width: `${bar.width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export interface ScheduleSeedingOutlineRowsProps {
  /** The outline's current row height, so the stand-ins line up with real rows. */
  rowHeight: number;
  /** The grip + structural-nudge lane a real row reserves left of its first column. */
  leftReserve?: number;
}

/**
 * The outline's stand-in rows while a template apply is still writing (#3312).
 *
 * Replaces `BlankOutlineDraftRow` — suppressed, not disabled. That row focuses
 * itself on mount, and a caret sitting in "Type your first item, then press Enter"
 * is the precise invitation this issue exists to withhold; a present-but-disabled
 * input would still read as "your row".
 *
 * Deliberately NOT `role="row"`. `TaskListPanel`'s `aria-rowcount` is derived from
 * `tasks.length`, which is zero here, so phantom rows would make the treegrid lie
 * about how many rows it has — and a `role="row"` with no `aria-level` inside a
 * `role="treegrid"` is an invalid tree node besides. `aria-hidden` drops the whole
 * subtree from the accessibility tree, so the treegrid correctly announces itself
 * as empty while the `role="status"` beside it explains why.
 */
export function ScheduleSeedingOutlineRows({
  rowHeight,
  leftReserve = 0,
}: ScheduleSeedingOutlineRowsProps) {
  return (
    <div aria-hidden="true" data-testid="schedule-seeding-outline" className="flex flex-col">
      {SEEDING_OUTLINE_WIDTHS.map((width, i) => (
        <div
          key={i}
          style={{ height: rowHeight }}
          className="flex items-center border-b border-neutral-border/60 px-2"
        >
          {leftReserve > 0 && (
            <span className="shrink-0" style={{ width: leftReserve }} />
          )}
          <span
            className="h-3 rounded-chip bg-neutral-surface-sunken motion-safe:animate-pulse"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}
