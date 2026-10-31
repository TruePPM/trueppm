import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { usePinned } from '@/hooks/usePins';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { programPath, projectPath } from '@/lib/refPath';
import { ArrowRightIcon, SearchIcon } from '@/components/Icons';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import type { RailItem } from './railItems';

const FLYOUT_WIDTH = 300;
const FLYOUT_HEIGHT = 420;
/** Pointer grace: the panel opens 6px below the trigger, so a slow pointer crossing the gap must not close it. */
const LEAVE_GRACE_MS = 160;

interface FlyoutRow {
  key: string;
  label: string;
  to: string;
  indent?: boolean;
}

/** The pinned, program and project rows the flyout lists, already filtered by `q`. */
export function flyoutRows(input: {
  q: string;
  pins: ReadonlyArray<{
    kind: 'project' | 'program';
    id: string;
    name: string;
    code: string | null;
  }>;
  programs: ReadonlyArray<{ id: string; name: string; code?: string | null }>;
  projects: ReadonlyArray<{ id: string; name: string; code?: string; programId: string | null }>;
}): { pinned: FlyoutRow[]; programs: FlyoutRow[] } {
  const needle = input.q.trim().toLowerCase();
  const matches = (name: string) => needle === '' || name.toLowerCase().includes(needle);
  const pinned = input.pins
    .filter((p) => matches(p.name))
    .map((p) => ({
      key: `pin:${p.kind}:${p.id}`,
      label: p.name,
      to:
        p.kind === 'program'
          ? programPath({ id: p.id, code: p.code }, 'overview')
          : projectPath({ id: p.id, code: p.code }, 'overview'),
    }));
  const programs: FlyoutRow[] = [];
  for (const program of input.programs) {
    const children = input.projects.filter((pr) => pr.programId === program.id && matches(pr.name));
    if (!matches(program.name) && children.length === 0) continue;
    programs.push({
      key: `program:${program.id}`,
      label: program.name,
      to: programPath(program, 'overview'),
    });
    for (const pr of children) {
      programs.push({
        key: `project:${pr.id}`,
        label: pr.name,
        to: projectPath(pr, 'overview'),
        indent: true,
      });
    }
  }
  const standalone = input.projects.filter((pr) => pr.programId === null && matches(pr.name));
  for (const pr of standalone) {
    programs.push({ key: `project:${pr.id}`, label: pr.name, to: projectPath(pr, 'overview') });
  }
  return { pinned, programs };
}

const ROW_LINK =
  'flex h-11 items-center gap-2 rounded-md px-2.5 text-sm no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus';

/**
 * The 64px rail's Work item. Hovering, focusing, or pressing ArrowRight/ArrowDown
 * on it opens a flyout with a search box, the person's pins, and every program
 * with its projects — so a laptop at 1024px, where the rail is always collapsed,
 * keeps a VISIBLE route to every project. The v1 rail removed its project browser
 * entirely at this width and left ⌘K as the only way across (Pass 1 audit, gap #4).
 *
 * The panel is portaled (rule 260), so it is not in Tab order after the link:
 * ArrowRight / ArrowDown move focus into it, Escape closes it and returns focus
 * to the link without re-opening it, and Tab out of either side closes it.
 */
export function WorkFlyout({ item }: { item: RailItem }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const listId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const leaveTimer = useRef<number | null>(null);
  // Set while Escape hands focus back to the link, so the link's own focus
  // handler does not immediately re-open the panel it just closed.
  const suppressFocusOpen = useRef(false);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLDivElement,
    HTMLDivElement
  >({
    open,
    width: FLYOUT_WIDTH,
    estimatedHeight: FLYOUT_HEIGHT,
    align: 'left',
    gap: 6,
    onDismiss: () => setOpen(false),
  });
  const { data: pins } = usePinned();
  const programsQuery = usePrograms();
  const projectsQuery = useProjects();

  const rows = useMemo(
    () =>
      flyoutRows({
        q,
        pins: pins ?? [],
        programs: programsQuery.data ?? [],
        projects: projectsQuery.data ?? [],
      }),
    [q, pins, programsQuery.data, projectsQuery.data],
  );
  const { Icon } = item;

  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setOpen(false), LEAVE_GRACE_MS);
  };
  useEffect(() => cancelLeave, []);

  const close = (returnFocus: boolean) => {
    cancelLeave();
    setOpen(false);
    if (returnFocus) {
      suppressFocusOpen.current = true;
      linkRef.current?.focus();
    }
  };
  const openAndEnter = () => {
    setOpen(true);
    // The panel mounts after the popover measures; focus its search on the next tick.
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  const onLinkKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      openAndEnter();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  };
  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };
  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (triggerRef.current?.contains(next) || popoverRef.current?.contains(next))) return;
    setOpen(false);
  };

  const loading = programsQuery.isLoading || projectsQuery.isLoading;
  const failed = programsQuery.error ?? projectsQuery.error;

  return (
    <div
      ref={triggerRef}
      role="presentation"
      className="relative"
      onMouseEnter={() => {
        cancelLeave();
        setOpen(true);
      }}
      onMouseLeave={scheduleLeave}
      onBlur={onBlur}
    >
      <Link
        ref={linkRef}
        to={item.to}
        aria-current={item.active ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-keyshortcuts="ArrowRight"
        onFocus={() => {
          if (suppressFocusOpen.current) {
            suppressFocusOpen.current = false;
            return;
          }
          setOpen(true);
        }}
        onKeyDown={onLinkKeyDown}
        className="group relative flex h-11 items-center justify-center rounded-md text-p1-text-2 no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-0 aria-[current=true]:bg-p1-brand-tint aria-[current=true]:text-p1-text-1"
      >
        <Icon className={`h-4 w-4 ${item.active ? 'text-p1-brand' : ''}`} aria-hidden="true" />
        <span className="sr-only">{item.label}</span>
      </Link>
      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={listId}
            role="dialog"
            aria-label="Programs and projects"
            style={popoverStyle}
            className="z-50 flex flex-col overflow-hidden rounded-lg border border-p1-hairline-strong bg-p1-surface-1 text-p1-text-1 shadow-pop"
          >
            <div
              role="presentation"
              onMouseEnter={cancelLeave}
              onMouseLeave={scheduleLeave}
              onKeyDown={onPanelKeyDown}
              onBlur={onBlur}
              className="flex min-h-0 flex-1 flex-col p-2"
            >
              <label className="flex h-11 items-center gap-2 rounded-md border border-p1-hairline bg-p1-surface-0 px-2.5 text-xs text-p1-text-3 focus-within:ring-2 focus-within:ring-p1-focus">
                <SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="sr-only">Find a program or project</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find a program or project"
                  className="h-full min-w-0 flex-1 bg-transparent text-sm text-p1-text-1 placeholder:text-p1-text-3 focus:outline-none"
                />
              </label>
              <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
                {rows.pinned.length > 0 && (
                  <>
                    <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-p1-text-3">
                      Pinned
                    </div>
                    {rows.pinned.map((r) => (
                      <Link key={r.key} to={r.to} className={`${ROW_LINK} text-p1-text-2`}>
                        <span className="truncate">{r.label}</span>
                      </Link>
                    ))}
                  </>
                )}
                <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-p1-text-3">Programs</div>
                {failed ? (
                  <QueryErrorState
                    variant="inline"
                    message="Couldn't load programs and projects."
                    onRetry={() => {
                      void programsQuery.refetch();
                    }}
                  />
                ) : loading ? (
                  <LoadingSkeleton label="Loading programs and projects…" variant="rows" rows={4} />
                ) : rows.programs.length === 0 ? (
                  <p className="px-2.5 py-2 text-sm text-p1-text-3">
                    {q.trim() ? 'Nothing matches.' : 'No programs or projects yet.'}
                  </p>
                ) : (
                  rows.programs.map((r) => (
                    <Link
                      key={r.key}
                      to={r.to}
                      className={`${ROW_LINK} ${r.indent ? 'pl-7 text-p1-text-2' : 'font-medium text-p1-text-1'}`}
                    >
                      <span className="truncate">{r.label}</span>
                    </Link>
                  ))
                )}
              </div>
              <Link
                to="/programs"
                className="mt-1 flex h-11 items-center gap-2 border-t border-p1-hairline px-2.5 text-sm text-p1-text-2 no-underline hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus"
              >
                All work
                <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
