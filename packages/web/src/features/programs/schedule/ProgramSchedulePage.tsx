import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { GanttIcon, WarningIcon } from '@/components/Icons';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useScheduleStore } from '@/stores/scheduleStore';
import { fmtUtcLong } from '@/lib/formatUtcDate';
import { CanvasScheduleTimeline } from '@/features/schedule/CanvasScheduleTimeline';
import { ZoomControl } from '@/features/schedule/ZoomControl';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/features/schedule/scheduleConstants';
import type { GanttEngine, GanttScaleData } from '@/features/schedule/engine';
import { useProgramId } from '@/hooks/useProgramId';
import { useProgram } from '@/hooks/useProgram';
import {
  useProgramSchedule,
  classifyProgramScheduleError,
  type ProgramScheduleExternalTask,
} from '../hooks/useProgramSchedule';
import { transformProgramSchedule } from './transformProgramSchedule';
import { ProgramScheduleLegend } from './ProgramScheduleLegend';
import { ExternalTaskHoverCard } from './ExternalTaskHoverCard';
import { ProgramScheduleLiveSync } from './ProgramScheduleLiveSync';

interface HoveredExternal {
  task: ProgramScheduleExternalTask;
  x: number;
  y: number;
}

/**
 * Program schedule view (issue 1118 / ADR-0120 §D6, ADR-0182).
 *
 * Renders the merged, program-true cross-project schedule in the existing canvas
 * Gantt engine, read-only: project lanes (synthetic summary rows), the
 * program-true critical path highlighted across lanes, and dashed cross-project
 * dependency arrows. All data is server-computed (render-don't-derive); the page
 * runs no CPM. Live updates come from each member project's WebSocket channel.
 */
export function ProgramSchedulePage() {
  const programId = useProgramId();
  const navigate = useNavigate();
  const breakpoint = useBreakpoint();
  const { data: program } = useProgram(programId);
  const { data, isLoading, error, refetch, isRefetching } = useProgramSchedule(programId);

  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const containerRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<GanttEngine | null>(null);
  const [hovered, setHovered] = useState<HoveredExternal | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const didFitRef = useRef(false);

  // Engine input: synthetic lanes + cross-project links. Empty until data loads.
  const { tasks, links } = useMemo(
    () => (data ? transformProgramSchedule(data) : { tasks: [], links: [] }),
    [data],
  );

  // External (redacted) tasks by id, for the minimal hover card.
  const externalById = useMemo(() => {
    const map = new Map<string, ProgramScheduleExternalTask>();
    for (const task of data?.tasks ?? []) {
      if (task.is_external) map.set(task.id, task);
    }
    return map;
  }, [data]);

  const memberProjectIds = useMemo(
    () => (data?.projects ?? []).map((p) => p.id),
    [data],
  );

  const handleEngineReady = useCallback((next: GanttEngine) => setEngine(next), []);

  // Reactive scales — keep totalCanvasWidth current as setTasks rebuilds the
  // scale (fit-to-project, live refetch). Drives the scroll spacer's width so
  // the canvas is horizontally scrollable when zoomed in (mirrors ScheduleView).
  const [scheduleScales, setScheduleScales] = useState<GanttScaleData | null>(null);
  useEffect(() => {
    if (!engine) return;
    setScheduleScales(engine.scales);
    return engine.on('scales-change', ({ scales }) => setScheduleScales(scales));
  }, [engine]);
  const totalCanvasWidth = scheduleScales?.totalWidth ?? 0;

  // Show the minimal card when an external bar is hovered; clear otherwise.
  useEffect(() => {
    if (!engine) return;
    return engine.on('task-hover', ({ taskId }) => {
      const ext = taskId ? externalById.get(taskId) : undefined;
      setHovered(ext ? { task: ext, x: mouseRef.current.x, y: mouseRef.current.y } : null);
    });
  }, [engine, externalById]);

  // Frame the whole program once after the tasks first render — the program may
  // start far from "today", so the default viewport would show empty space.
  useEffect(() => {
    didFitRef.current = false;
  }, [programId]);
  useEffect(() => {
    if (!engine || tasks.length === 0 || didFitRef.current) return;
    const raf = requestAnimationFrame(() => {
      engine.fitToProject();
      didFitRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
    // Depend on `tasks` (identity), not `tasks.length`: navigating to another
    // program with the same task count must still re-fit (didFitRef was reset on
    // the programId change). A live refetch of the SAME program also changes
    // `tasks` identity, but didFitRef is still set, so it won't re-fit (no jump).
  }, [engine, tasks]);

  const programName = program?.name ?? 'Program';

  // --- Small viewport: the canvas Gantt is desktop-first; don't mount it. ---
  if (breakpoint === 'sm') {
    return (
      <EmptyState
        className="h-full"
        icon={GanttIcon}
        title="Best viewed on a larger screen"
        description="The program schedule is a wide timeline. Open it on a tablet or desktop to explore the cross-project critical path."
      />
    );
  }

  const header = (
    <div className="shrink-0 border-b border-neutral-border px-4 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-neutral-text-primary">
              Program Schedule
            </h1>
            {/* Make the boundary legible: this view never edits tasks or sprints
               (VoC — the read-only constraint is what makes it safe for agile
               teams; you edit on each project's own schedule). */}
            <span className="rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs font-medium text-neutral-text-secondary">
              Read-only
            </span>
          </div>
          {data && data.tasks.length > 0 && (
            <p className="truncate text-[13px] text-neutral-text-secondary">
              Cross-project critical path across {data.projects.length}{' '}
              {data.projects.length === 1 ? 'project' : 'projects'}
              {data.start_date && data.finish_date && (
                <span className="text-neutral-text-disabled">
                  {' · '}
                  {fmtUtcLong(data.start_date)} – {fmtUtcLong(data.finish_date)}
                </span>
              )}
            </p>
          )}
        </div>
        {data && data.tasks.length > 0 && (
          <ZoomControl onFit={() => engine?.fitToProject()} />
        )}
      </div>
      {data && data.tasks.length > 0 && (
        <div className="mt-2">
          <ProgramScheduleLegend hasExternalTasks={externalById.size > 0} />
        </div>
      )}
    </div>
  );

  let body: ReactNode;
  if (isLoading) {
    body = <LoadingSkeleton />;
  } else if (error) {
    const kind = classifyProgramScheduleError(error);
    if (kind === 'not-computed') {
      body = <NoScheduleEmptyState programId={programId} navigate={navigate} />;
    } else if (kind === 'too-large') {
      body = (
        <EmptyState
          className="h-full"
          icon={WarningIcon}
          title="This program is too large to chart live"
          description="This program has more tasks than the live program schedule can compute on demand. Open an individual project's schedule to view its critical path."
          action={
            <Button
              variant="secondary"
              onClick={() => void navigate(`/programs/${programId}/projects`)}
            >
              Go to Projects
            </Button>
          }
        />
      );
    } else if (kind === 'forbidden') {
      body = (
        <div className="flex h-full items-center justify-center px-6">
          <p role="alert" className="text-sm text-semantic-critical">
            You don&apos;t have access to this program&apos;s schedule.
          </p>
        </div>
      );
    } else {
      body = (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
          <p role="alert" className="text-sm text-semantic-critical">
            Couldn&apos;t load the program schedule.
          </p>
          <Button variant="secondary" onClick={() => void refetch()} disabled={isRefetching}>
            {isRefetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      );
    }
  } else if (!data || data.tasks.length === 0) {
    body = <NoScheduleEmptyState programId={programId} navigate={navigate} />;
  } else {
    body = (
      <div
        ref={containerRef}
        data-testid="program-schedule-canvas-scroll"
        className="relative min-h-0 flex-1 overflow-auto"
        onMouseMove={(e) => {
          const { clientX, clientY } = e;
          mouseRef.current = { x: clientX, y: clientY };
          // While an external bar is hovered, let its card follow the cursor —
          // the engine's `task-hover` only fires on a task-id change, not on every
          // pointer move, so without this the card would freeze at the entry point.
          // Returning the same reference when nothing is hovered skips the render.
          setHovered((h) => (h ? { ...h, x: clientX, y: clientY } : h));
        }}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Scroll spacer sized to the full canvas — this is what makes the
            container scrollable so the virtualizing engine receives a scroll
            offset (without it scrollHeight === clientHeight and rows past the
            viewport are unreachable, issue 1624). Height covers every lane row;
            minWidth:'100%' fills the viewport when the timeline is narrower.
            Mirrors ScheduleView's scaffolding. */}
        <div
          style={{
            width: totalCanvasWidth > 0 ? totalCanvasWidth : '100%',
            minWidth: '100%',
            height: HEADER_HEIGHT + tasks.length * ROW_HEIGHT,
            position: 'relative',
          }}
        >
          {/* Sticky viewport-sized wrapper holds the canvas layers pinned to the
              visible area while the spacer above provides the scroll range. Sized
              via the engine's --gantt-vw/vh vars (100% would resolve to the wide
              spacer and break the pinning). pointer-events:none; the interaction
              canvas re-enables them. */}
          <div
            style={{
              position: 'sticky',
              top: 0,
              left: 0,
              width: 'var(--gantt-vw, 100%)',
              height: 'var(--gantt-vh, 100%)',
              pointerEvents: 'none',
            }}
          >
            <CanvasScheduleTimeline
              tasks={tasks}
              links={links}
              zoomLevel={zoomLevel}
              containerRef={containerRef}
              onEngineReady={handleEngineReady}
            />
          </div>
        </div>
        {hovered && (
          <ExternalTaskHoverCard task={hovered.task} x={hovered.x} y={hovered.y} />
        )}
        {/* Live updates: one socket per member project → invalidate this query. */}
        <ProgramScheduleLiveSync programId={programId ?? ''} projectIds={memberProjectIds} />
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-app-canvas"
      aria-label={`${programName} schedule`}
    >
      {header}
      {body}
    </div>
  );
}

/** Inline pulse skeleton — no generic page Skeleton exists; mirrors the program
 *  pages' `animate-pulse` idiom (e.g. KpiSkeleton). */
function LoadingSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-4" aria-busy="true" aria-label="Loading program schedule">
      {[0, 1, 2].map((lane) => (
        <div key={lane} className="space-y-2">
          <div className="h-4 w-40 motion-safe:animate-pulse rounded-chip bg-neutral-surface-raised" />
          {[0, 1].map((row) => (
            <div
              key={row}
              className="ml-4 h-3 motion-safe:animate-pulse rounded-chip bg-neutral-surface-raised"
              style={{ width: `${40 + ((lane + row) % 3) * 18}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function NoScheduleEmptyState({
  programId,
  navigate,
}: {
  programId: string | undefined;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <EmptyState
      className="h-full"
      icon={GanttIcon}
      title="No program schedule yet"
      description="Once a member project's schedule has been calculated, this program's cross-project critical path appears here."
      action={
        <Button
          variant="secondary"
          onClick={() => void navigate(`/programs/${programId}/projects`)}
        >
          Go to Projects
        </Button>
      }
    />
  );
}
