import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { usePinned } from '@/hooks/usePins';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { programPath, projectPath } from '@/lib/refPath';
import { ArrowRightIcon, SearchIcon } from '@/components/Icons';
import type { RailItem } from './railItems';

const FLYOUT_WIDTH = 300;
const FLYOUT_HEIGHT = 420;

interface FlyoutRow {
  key: string;
  label: string;
  to: string;
  indent?: boolean;
  meta?: string;
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

/**
 * The 64px rail's Work item. Hovering or focusing it opens a flyout with a
 * search box, the person's pins, and every program with its projects — so a
 * laptop at 1024px, where the rail is always collapsed, keeps a VISIBLE route
 * to every project. The v1 rail removed its project browser entirely at this
 * width and left ⌘K as the only way across (Pass 1 audit, gap #4).
 */
export function WorkFlyout({ item }: { item: RailItem }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const listId = useId();
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
  const { data: programs } = usePrograms();
  const { data: projects } = useProjects();

  const rows = useMemo(
    () => flyoutRows({ q, pins: pins ?? [], programs: programs ?? [], projects: projects ?? [] }),
    [q, pins, programs, projects],
  );
  const { Icon } = item;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.querySelector('a')?.focus();
    }
  };

  return (
    <div
      ref={triggerRef}
      role="presentation"
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && (triggerRef.current?.contains(next) || popoverRef.current?.contains(next)))
          return;
        setOpen(false);
      }}
      onKeyDown={onKeyDown}
    >
      <Link
        to={item.to}
        aria-current={item.active ? 'page' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="group relative flex h-11 items-center justify-center rounded-md text-p1-text-2 no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-0 aria-[current=page]:bg-p1-brand-tint aria-[current=page]:text-p1-text-1"
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
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
              onKeyDown={onKeyDown}
              className="flex min-h-0 flex-1 flex-col p-2"
            >
              <label className="flex h-8 items-center gap-2 rounded-md border border-p1-hairline bg-p1-surface-0 px-2.5 text-xs text-p1-text-3 focus-within:ring-2 focus-within:ring-p1-focus">
                <SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="sr-only">Find a program or project</span>
                <input
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
                      <Link
                        key={r.key}
                        to={r.to}
                        className="flex h-11 items-center gap-2 rounded-md px-2.5 text-sm text-p1-text-2 no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus"
                      >
                        <span className="truncate">{r.label}</span>
                      </Link>
                    ))}
                  </>
                )}
                <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-p1-text-3">Programs</div>
                {rows.programs.length === 0 && (
                  <p className="px-2.5 py-2 text-sm text-p1-text-3">
                    {q.trim() ? 'Nothing matches.' : 'No programs or projects yet.'}
                  </p>
                )}
                {rows.programs.map((r) => (
                  <Link
                    key={r.key}
                    to={r.to}
                    className={`flex h-11 items-center gap-2 rounded-md px-2.5 text-sm no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus ${r.indent ? 'pl-7 text-p1-text-2' : 'font-medium text-p1-text-1'}`}
                  >
                    <span className="truncate">{r.label}</span>
                  </Link>
                ))}
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
