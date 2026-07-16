import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import {
  classifyShareError,
  fetchPublicSchedule,
  type PublicSchedule,
  type PublicScheduleTask,
  type PublicShareErrorKind,
} from './scheduleShareApi';
import { buildDependencyPaths, type DepAnchor, type DepSegment } from './scheduleSharePaths';
import { useNoReferrer } from './useNoReferrer';
import { MCP_EXAMPLE_PROMPTS } from '@/lib/mcpExamplePrompts';

// Fixed geometry so the label column, timeline column, and the SVG dependency
// overlay share one coordinate space (rows never wrap — labels are truncated).
const LABEL_W = 220; // px, mirrors the canonical Gantt task column default (rule 43)
const ROW_H = 28; // px per task row (box-border, so borders don't drift the total)
const HEADER_H = 32; // px month-axis / "Task" header row

/**
 * Public, unauthenticated, read-only schedule viewer (#1486, ADR-0265). Standalone —
 * NOT inside the app shell (no sidebar/topbar/auth). Fetches via bare axios so it
 * never touches the authenticated apiClient, and deliberately does NOT mount the
 * authenticated canvas Gantt engine (Zustand/WASM/apiClient-coupled). It renders a
 * lightweight, non-interactive bar timeline from the minimized projection: no drag,
 * no popover, no create affordance anywhere (matching PublicBoardSharePage).
 */

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function StatePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-surface px-4">
      <div className="w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
        <h1 className="mb-1 text-sm font-semibold text-neutral-text-primary">{title}</h1>
        <p className="text-xs text-neutral-text-secondary">{body}</p>
      </div>
      {/* Brand mark on every state (incl. error/revoked) so an external viewer can
          tell this is a legitimate TruePPM page, matching the AuthShell precedent. */}
      <p className="mt-4 text-xs font-medium text-neutral-text-disabled">TruePPM</p>
    </div>
  );
}

/** Parse a `YYYY-MM-DD` schedule date as a stable UTC midnight (no TZ drift). */
function parseDay(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Short day label, e.g. "30 Jun", from an epoch ms in UTC. */
function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

interface Placed {
  task: PublicScheduleTask;
  startMs: number | null;
  endMs: number | null;
  depth: number;
  isSummary: boolean;
}

/** Resolve each task's [start, end] window, WBS depth, and summary flag. */
function placeTasks(tasks: PublicScheduleTask[]): Placed[] {
  // A task is a summary iff another task's wbs_path is nested beneath it (child.
  // wbs starts with `parent.wbs + '.'`). Summaries render as spanning brackets.
  const paths = tasks.map((t) => t.wbs_path).filter(Boolean);
  return tasks.map((task) => {
    const startMs = parseDay(task.early_start) ?? parseDay(task.planned_start);
    let endMs = parseDay(task.early_finish);
    if (startMs !== null && endMs === null) {
      endMs = startMs + Math.max(0, task.duration) * DAY_MS;
    }
    const depth = task.wbs_path ? Math.min(task.wbs_path.split('.').length - 1, 6) : 0;
    const prefix = task.wbs_path ? `${task.wbs_path}.` : '';
    const isSummary = Boolean(prefix) && paths.some((p) => p.startsWith(prefix));
    return { task, startMs, endMs, depth, isSummary };
  });
}

interface Scale {
  minMs: number;
  spanMs: number;
  months: { label: string; leftPct: number; widthPct: number }[];
}

function buildScale(placed: Placed[]): Scale {
  const starts = placed.map((p) => p.startMs).filter((v): v is number => v !== null);
  const ends = placed.map((p) => p.endMs).filter((v): v is number => v !== null);
  if (starts.length === 0 || ends.length === 0) {
    return { minMs: 0, spanMs: 1, months: [] };
  }
  const minMs = Math.min(...starts);
  const maxMs = Math.max(...ends);
  const spanMs = Math.max(maxMs - minMs, DAY_MS);

  // Month gridlines at real month boundaries, positioned proportionally so bars and
  // month labels share one scale (evenly-spaced columns would misalign the bars).
  const months: Scale['months'] = [];
  const first = new Date(minMs);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  while (cursor <= maxMs) {
    const d = new Date(cursor);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const segStart = Math.max(cursor, minMs);
    const segEnd = Math.min(next, maxMs);
    months.push({
      label: `${MONTHS[d.getUTCMonth()]}`,
      leftPct: ((segStart - minMs) / spanMs) * 100,
      widthPct: ((segEnd - segStart) / spanMs) * 100,
    });
    cursor = next;
  }
  return { minMs, spanMs, months };
}

function MonthAxis({ months }: { months: Scale['months'] }) {
  return (
    <div className="relative h-5">
      {months.map((m, i) => (
        <span
          key={`${m.label}-${i}`}
          className="absolute top-0 truncate border-l border-neutral-border pl-1 text-xs text-neutral-text-secondary"
          style={{ left: `${m.leftPct}%`, width: `${m.widthPct}%` }}
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}

/** Faint month gridlines behind the bars so a bar's month is readable at a glance. */
function GridLines({ months }: { months: Scale['months'] }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {months.map((m, i) => (
        <span
          key={i}
          className="absolute top-0 bottom-0 border-l border-neutral-border/50"
          style={{ left: `${m.leftPct}%` }}
        />
      ))}
    </div>
  );
}

function Lane({ placed, scale }: { placed: Placed; scale: Scale }) {
  const { task, startMs, endMs, isSummary } = placed;
  const pct = Math.max(0, Math.min(100, Math.round(task.percent_complete)));
  const scheduled = startMs !== null && endMs !== null;
  if (!scheduled) {
    return (
      <span className="absolute left-1 top-1/2 -translate-y-1/2 text-xs text-neutral-text-disabled">
        Unscheduled
      </span>
    );
  }
  const left = ((startMs - scale.minMs) / scale.spanMs) * 100;
  const width = Math.max(((endMs - startMs) / scale.spanMs) * 100, 1.5);

  if (task.is_milestone) {
    // A diamond at the milestone date, with its name+date labelled to the right.
    // Milestones are brand-accent amber (#E8A020) to match the canonical canvas
    // renderer (GanttRenderer COLOR.milestone) — never brand-primary sage, which
    // would be indistinguishable from a normal task bar.
    return (
      <>
        <span
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-brand-accent"
          style={{ left: `${left}%` }}
          aria-hidden="true"
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-2 text-xs text-neutral-text-secondary"
          style={{ left: `${left}%` }}
        >
          {task.name} · {dayLabel(startMs)}
        </span>
      </>
    );
  }

  if (isSummary) {
    // Summary rollup: a thin bracket bar spanning its children, no % fill.
    return (
      <span
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-neutral-text-secondary"
        style={{ left: `${left}%`, width: `${width}%` }}
        aria-label={`${task.name} summary`}
      />
    );
  }

  return (
    <span
      className={`absolute top-1/2 flex h-3 -translate-y-1/2 items-center overflow-hidden rounded-full ${
        task.is_critical ? 'bg-semantic-critical' : 'bg-brand-primary'
      }`}
      style={{ left: `${left}%`, width: `${width}%` }}
      title={`${task.early_start ?? ''} → ${task.early_finish ?? ''} · ${pct}%`}
      aria-label={`${task.name}, ${pct}% complete`}
    >
      {pct > 0 && pct < 100 ? (
        <span className="h-full bg-black/20" style={{ width: `${pct}%` }} aria-hidden="true" />
      ) : null}
    </span>
  );
}

/** Left-column task label: WBS indent, id/◆ glyph, CP chip, name. */
function LabelCell({ placed }: { placed: Placed }) {
  const { task, depth, isSummary } = placed;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 border-b border-neutral-border px-3 last:border-b-0"
      style={{ height: ROW_H }}
    >
      <span style={{ width: depth * 12 }} aria-hidden="true" className="shrink-0" />
      <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
        {task.is_milestone ? '◆' : task.wbs_path || task.short_id}
      </span>
      {task.is_critical && !task.is_milestone ? (
        // Non-color critical signal (WCAG 1.4.1, DS rule 26) alongside the red bar.
        <span className="shrink-0 rounded-chip bg-semantic-critical-bg px-1 text-xs font-semibold text-semantic-critical">
          CP
        </span>
      ) : null}
      <span
        className={`truncate text-[12px] leading-snug ${
          isSummary ? 'font-semibold text-neutral-text-primary' : 'text-neutral-text-primary'
        }`}
      >
        {task.name}
      </span>
    </div>
  );
}

/** Right-column timeline row: month gridlines + the task's bar/diamond. */
function TimelineCell({ placed, scale }: { placed: Placed; scale: Scale }) {
  return (
    <div
      className="relative border-b border-neutral-border last:border-b-0"
      style={{ height: ROW_H }}
    >
      <GridLines months={scale.months} />
      <Lane placed={placed} scale={scale} />
    </div>
  );
}

/**
 * SVG overlay drawing one charcoal connector per dependency edge (rule 75:
 * arrow color is charcoal). Decorative (`aria-hidden`) — the dependency data is
 * not otherwise surfaced as text on this lightweight external view, matching the
 * canonical canvas, which is itself `aria-hidden`. Renders nothing until the
 * timeline width is measured.
 */
function DependencyLayer({
  segments,
  width,
  height,
}: {
  segments: DepSegment[];
  width: number;
  height: number;
}) {
  if (width <= 0 || segments.length === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 text-neutral-text-secondary"
      width={width}
      height={height}
      aria-hidden="true"
    >
      {segments.map((seg) => (
        <g key={seg.key}>
          <path
            d={seg.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.7}
          />
          <polygon points={seg.arrow} fill="currentColor" opacity={0.7} />
        </g>
      ))}
    </svg>
  );
}

function Schedule({ schedule }: { schedule: PublicSchedule }) {
  const placed = useMemo(() => placeTasks(schedule.tasks), [schedule.tasks]);
  const scale = useMemo(() => buildScale(placed), [placed]);
  const criticalCount = placed.filter((p) => p.task.is_critical && !p.task.is_milestone).length;
  const hasMilestone = placed.some((p) => p.task.is_milestone);

  // Measure the timeline column so the SVG dependency overlay can convert the
  // bars' percentage positions into pixel coordinates (arrowheads must not scale).
  const rowsRef = useRef<HTMLDivElement>(null);
  const [timelineWidth, setTimelineWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const measure = () => setTimelineWidth(el.clientWidth);
    measure();
    // jsdom (unit tests) has no ResizeObserver — guard like the board reflow does.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [placed.length]);

  // Bar edges (as % of the timeline) keyed by short_id — the same scale the bars use.
  const anchors = useMemo(() => {
    const m = new Map<string, DepAnchor>();
    placed.forEach((p, i) => {
      const startPct =
        p.startMs !== null ? ((p.startMs - scale.minMs) / scale.spanMs) * 100 : null;
      const endPct = p.endMs !== null ? ((p.endMs - scale.minMs) / scale.spanMs) * 100 : null;
      m.set(p.task.short_id, { startPct, endPct, rowIndex: i });
    });
    return m;
  }, [placed, scale]);

  const depSegments = useMemo(
    () => buildDependencyPaths(anchors, schedule.dependencies, timelineWidth, ROW_H),
    [anchors, schedule.dependencies, timelineWidth],
  );

  return (
    <div className="min-h-screen bg-neutral-surface">
      <header className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-neutral-text-primary">
              {schedule.project.name ? `${schedule.project.name} — Schedule` : 'Schedule'}
            </h1>
            {schedule.project.short_id ? (
              <span className="text-xs text-neutral-text-secondary">
                {schedule.project.short_id}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-chip border border-neutral-border bg-neutral-surface px-2 py-0.5 text-xs font-medium text-neutral-text-secondary">
            Read-only shared view
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {placed.length === 0 ? (
          <div className="rounded-card border border-dashed border-neutral-border p-10 text-center">
            <p className="text-[12px] text-neutral-text-secondary">No scheduled tasks to show yet.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-neutral-text-secondary">
              {criticalCount > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-4 rounded-full bg-semantic-critical" aria-hidden="true" />
                  Critical path (CP)
                </span>
              ) : null}
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-4 rounded-full bg-brand-primary" aria-hidden="true" />
                Task
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-1.5 rounded-sm bg-neutral-text-secondary" aria-hidden="true" />
                Summary
              </span>
              {hasMilestone ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rotate-45 bg-brand-accent" aria-hidden="true" />
                  Milestone
                </span>
              ) : null}
              {schedule.dependencies.length > 0 ? (
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="8" aria-hidden="true" className="text-neutral-text-secondary">
                    <path
                      d="M1 4 H13"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.25}
                      strokeLinecap="round"
                      opacity={0.7}
                    />
                    <polygon points="18,4 13,1.5 13,6.5" fill="currentColor" opacity={0.7} />
                  </svg>
                  Dependency
                </span>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-card border border-neutral-border bg-neutral-surface-raised">
              <div className="flex min-w-[640px]">
                {/* Label column — fixed width so the timeline coordinate space is stable. */}
                <div className="shrink-0 border-r border-neutral-border" style={{ width: LABEL_W }}>
                  <div
                    className="border-b border-neutral-border px-3 pb-1 pt-2"
                    style={{ height: HEADER_H }}
                  >
                    <span className="text-xs font-semibold text-neutral-text-primary">Task</span>
                  </div>
                  {placed.map((p) => (
                    <LabelCell key={p.task.short_id} placed={p} />
                  ))}
                </div>
                {/* Timeline column — bars, gridlines, and the dependency overlay share its width. */}
                <div className="min-w-0 flex-1 px-3">
                  <div className="border-b border-neutral-border pb-1 pt-2" style={{ height: HEADER_H }}>
                    {scale.months.length > 0 ? <MonthAxis months={scale.months} /> : null}
                  </div>
                  <div className="relative" ref={rowsRef}>
                    <DependencyLayer
                      segments={depSegments}
                      width={timelineWidth}
                      height={placed.length * ROW_H}
                    />
                    {placed.map((p) => (
                      <TimelineCell key={p.task.short_id} placed={p} scale={scale} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
        {schedule.truncated ? (
          <p className="mt-4 text-center text-xs text-neutral-text-secondary">
            Showing the first 1,000 tasks.
          </p>
        ) : null}
      </main>

      <McpPromptsCallout />

      <footer className="py-6 text-center text-xs text-neutral-text-disabled">
        Shared via TruePPM · read-only
      </footer>
    </div>
  );
}

/**
 * "Ask this schedule anything" prompt callout (#1847). The hosted read-only demo
 * is served through this public share page, so it is the first thing a Claude
 * Desktop evaluator sees — but nothing here tells them what to type once they
 * connect the MCP server. This surfaces the curated starter prompts from the
 * shared single-source-of-truth constant (matched to the docs' "Example prompts"
 * and the in-app connect dialog). Static, read-only copy: a labeled list and a
 * docs link — no create/edit affordance, preserving the page's read-only
 * contract. `MCP_EXAMPLE_PROMPTS` is never empty, so this always renders.
 */
function McpPromptsCallout() {
  return (
    <section
      aria-label="Explore this schedule with an AI assistant"
      className="mx-auto mt-6 max-w-6xl px-4"
    >
      <div className="rounded-card border border-brand-primary/20 bg-brand-primary/5 p-4">
        <h2 className="text-sm font-semibold text-neutral-text-primary">
          Ask this schedule anything
        </h2>
        <p className="mt-1 text-[12px] text-neutral-text-secondary">
          Point an MCP client such as Claude Desktop at a TruePPM instance and ask the live
          schedule real questions — answered server-side by the same CPM and Monte Carlo engine,
          never guessed. Try asking:
        </p>
        <ul className="mt-2 space-y-1">
          {MCP_EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt} className="flex gap-2 text-[12px] text-neutral-text-secondary">
              <span aria-hidden="true" className="text-brand-primary">
                &ldquo;
              </span>
              <span>{prompt}</span>
            </li>
          ))}
        </ul>
        <a
          href="https://docs.trueppm.com/features/mcp-server"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block rounded text-[12px] text-brand-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Connect an AI assistant →
        </a>
      </div>
    </section>
  );
}

export function PublicScheduleSharePage() {
  const { token } = useParams<{ token: string }>();
  const [schedule, setSchedule] = useState<PublicSchedule | null>(null);
  const [error, setError] = useState<PublicShareErrorKind | null>(null);
  const [loading, setLoading] = useState(true);
  useNoReferrer();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchPublicSchedule(token ?? '')
      .then((data) => {
        if (active) setSchedule(data);
      })
      .catch((err: unknown) => {
        if (active) setError(classifyShareError(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (loading) {
    return <StatePage title="Loading…" body="Fetching the shared schedule." />;
  }
  if (error === 'revoked') {
    return (
      <StatePage
        title="This link is no longer active"
        body="It was revoked, or it has expired. Ask the project owner for a new share link."
      />
    );
  }
  if (error === 'rate_limited') {
    return (
      <StatePage
        title="Too many requests"
        body="This link has been opened a lot recently. Wait a minute and refresh."
      />
    );
  }
  if (error || !schedule) {
    return (
      <StatePage
        title="This share link isn't available"
        body="The link may be invalid, or sharing may be turned off for this project."
      />
    );
  }
  return <Schedule schedule={schedule} />;
}
