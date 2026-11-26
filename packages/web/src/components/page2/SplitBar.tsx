export interface SplitBarProps {
  /** Percent of the person's capacity booked on this project. */
  thisProject: number;
  /** Percent booked on other projects. */
  otherProjects: number;
  /** Percent not booked. Passed in, never derived here. */
  unbooked: number;
}

const HATCH =
  'repeating-linear-gradient(45deg, var(--hatch-limited-view) 0 2px, transparent 2px 6px)';

/**
 * Pass 3 split bar (#4802): this project in ink, other projects in load-3,
 * unbooked in a hatch. The text line under it names every share, so the bar is
 * `aria-hidden` and never the only signal. When the shares total more than 100
 * (over-booked) the segments scale to that total; the printed numbers do not.
 */
export function SplitBar({ thisProject, otherProjects, unbooked }: SplitBarProps) {
  const total = Math.max(100, thisProject + otherProjects + unbooked);
  const width = (v: number) => `${(Math.max(0, v) / total) * 100}%`;
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-hidden="true"
        className="flex h-3 w-full overflow-hidden rounded-sm border border-p1-hairline-strong bg-p1-surface-1"
      >
        <span
          data-segment="this"
          className="h-full bg-p1-text-1 forced-colors:bg-[CanvasText]"
          style={{ width: width(thisProject) }}
        />
        <span
          data-segment="other"
          className="h-full bg-p1-load-3 forced-colors:bg-[GrayText]"
          style={{ width: width(otherProjects) }}
        />
        <span
          data-segment="unbooked"
          className="h-full"
          style={{ width: width(unbooked), backgroundImage: HATCH }}
        />
      </div>
      <p className="text-xs text-p1-text-2">
        This project {thisProject}% · Other projects {otherProjects}% · Unbooked {unbooked}%
      </p>
    </div>
  );
}
