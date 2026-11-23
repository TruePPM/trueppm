import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle } from '@/components/page2/PageTitle';
import { FOCUS_RING, PAGE_BUTTON } from '@/components/page2/classes';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Button } from '@/components/Button';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useProjectId } from '@/hooks/useProjectId';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCreateTask } from '@/hooks/useTaskMutations';
import { useMinWidth } from '@/features/shell2/useMinWidth';
import type { Task, TaskStatus } from '@/types';
import { boardReadOnly, useBoardIdentity } from '../boardView/useBoardIdentity';
import { Board2Card } from './Board2Card';
import {
  applyFilter,
  columnHeads,
  groupIntoLanes,
  splitDone,
  summarizeLane,
  type Board2Filter,
  type ColumnHead,
} from './board2Model';

const WIP_DEFINITION =
  'Work-in-progress limit: the most cards this column should hold at once. It is advisory; a card can still be dropped over it.';

const fmtDay = (iso: string | null) => (iso ? fmtUtcShort(iso) : null);

const TOOL = `inline-flex h-9 items-center gap-1.5 rounded-md border border-p1-hairline bg-p1-surface-1 px-3 text-sm text-p1-text-1 hover:bg-p1-surface-2 aria-pressed:bg-p1-brand-tint max-md:h-11 [@media(pointer:coarse)]:h-11 ${FOCUS_RING}`;

/** A toolbar popover: closes on Escape (focus returns to the trigger) and on an outside press. */
function Popover({
  label,
  ariaLabel,
  children,
  align = 'left',
}: {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    // The key handler only routes keys that bubble up from the menu's own buttons.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          const items = [
            ...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
          ];
          const i = items.indexOf(document.activeElement as HTMLElement);
          const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
          items[(next + items.length) % items.length]?.focus();
          e.preventDefault();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={TOOL}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className={`absolute top-full z-30 mt-1 max-h-[min(70vh,24rem)] min-w-56 overflow-y-auto rounded-md border border-p1-hairline bg-p1-surface-1 p-1 shadow-pop ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuCheck({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onChange}
      className={`flex h-11 w-full items-center gap-2 rounded px-3 text-left text-sm text-p1-text-1 hover:bg-p1-surface-2 md:h-9 ${FOCUS_RING}`}
    >
      <span aria-hidden="true" className="w-4">
        {checked ? '✓' : ''}
      </span>
      {children}
    </button>
  );
}

function ColumnHeader({ head, showWip }: { head: ColumnHead; showWip: boolean }) {
  const over = head.wip === 'over';
  return (
    <div
      data-testid={`board2-colhead-${head.status}`}
      data-wip={head.wip}
      className="flex min-w-0 items-center gap-2 px-1 text-xs font-medium text-p1-text-2"
    >
      <span className="truncate text-p1-text-1">{head.label}</span>
      <span aria-label={`${head.count} cards`}>{head.count}</span>
      {showWip && head.wipLimit != null && (
        <span
          className={
            over ? 'font-semibold text-p1-risk-text' : head.wip === 'at' ? 'text-p1-risk-text' : ''
          }
        >
          <DefinitionTip
            term={`${over ? '▲ ' : ''}WIP ${head.count}/${head.wipLimit}${over ? ' over limit' : ''}`}
            definition={WIP_DEFINITION}
          />
        </span>
      )}
    </div>
  );
}

/**
 * The shell v2 Board page (#4797, behind `shell_v2`): phase lanes, five toolbar
 * controls, four equal columns above the fold. It reads and writes through the SAME
 * hooks as the v1 board (`useScheduleTasks`, `useUpdateTaskStatus`), so a card move
 * keeps the optimistic update, the rollback, the offline outbox and the server's
 * `broadcast_board_event` fan-out. Nothing about the server changed.
 */
export function Board2Page() {
  const { projectId, projectIdOrNull, currentRole } = useBoardIdentity(useProjectId());
  const { columns: rawColumns } = useBoardConfig(projectIdOrNull);
  const { tasks, isLoading, error } = useScheduleTasks();
  const updateStatus = useUpdateTaskStatus();
  const createTask = useCreateTask(projectIdOrNull);
  const online = useOnlineStatus();
  const { formatInstantTime } = useUserDateFormat();
  const isDesktop = useMinWidth(768);
  const readOnly = boardReadOnly(currentRole, false, false);

  const [filter, setFilter] = useState<Board2Filter>({ criticalOnly: false, blockedOnly: false });
  const [lanesOn, setLanesOn] = useState(true);
  const [backlogOpen, setBacklogOpen] = useState(true);
  const [showWip, setShowWip] = useState(true);
  const [showFields, setShowFields] = useState(true);
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(new Set());
  const [doneOpen, setDoneOpen] = useState<ReadonlySet<string>>(new Set());
  const [phoneStatus, setPhoneStatus] = useState<TaskStatus | null>(null);
  const [phoneLane, setPhoneLane] = useState('all');
  const [adding, setAdding] = useState<null | 'NOT_STARTED' | 'BACKLOG'>(null);
  const [newName, setNewName] = useState('');
  const [held, setHeld] = useState<{ id: string; target: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const dragged = useRef<Task | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const newInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) newInput.current?.focus();
  }, [adding]);

  // The copy the board falls back to when the network is gone. Stamped on every
  // successful read, so "showing your 09:12 copy" names when it was last true.
  const lastGood = useRef<Date | null>(null);
  if (tasks && !error) lastGood.current = new Date();

  const columns = useMemo(
    () => rawColumns.filter((c) => c.visible && c.status !== 'BACKLOG'),
    [rawColumns],
  );
  const all = useMemo(() => tasks ?? [], [tasks]);
  const isCard = useMemo(() => {
    const ids = new Set(groupIntoLanes(all, undefined).flatMap((l) => l.tasks.map((t) => t.id)));
    return (t: Task) => ids.has(t.id);
  }, [all]);
  const backlog = useMemo(
    () => all.filter((t) => isCard(t) && t.status === 'BACKLOG'),
    [all, isCard],
  );
  const heads = useMemo(
    () =>
      columnHeads(
        columns,
        all.filter((t) => t.status !== 'BACKLOG'),
      ),
    [columns, all],
  );
  const lanes = useMemo(() => {
    const shown = new Set(
      applyFilter(
        all.filter((t) => isCard(t) && t.status !== 'BACKLOG'),
        filter,
      ).map((t) => t.id),
    );
    return groupIntoLanes(all, undefined, lanesOn, (t) => shown.has(t.id));
  }, [all, isCard, filter, lanesOn]);

  const targets: TaskStatus[] = useMemo(
    () => [
      ...(backlogOpen && isDesktop ? (['BACKLOG'] as TaskStatus[]) : []),
      ...columns.map((c) => c.status),
    ],
    [backlogOpen, isDesktop, columns],
  );
  const labelOf = (s: TaskStatus) =>
    s === 'BACKLOG' ? 'Backlog' : (columns.find((c) => c.status === s)?.label ?? s);

  const move = useCallback(
    (task: Task, status: TaskStatus) => {
      if (readOnly || task.status === status) return;
      updateStatus.mutate({ projectId, taskId: task.id, status });
      setAnnounce(`Moved ${task.name} to ${labelOf(status)}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly, updateStatus, columns, projectId],
  );

  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, task: Task) => {
    if (held?.id === task.id) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = Math.max(
          0,
          Math.min(targets.length - 1, held.target + (e.key === 'ArrowRight' ? 1 : -1)),
        );
        setHeld({ id: task.id, target: next });
        setAnnounce(`Over ${labelOf(targets[next])}`);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const dest = targets[held.target];
        setHeld(null);
        if (dest) move(task, dest);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setHeld(null);
        setAnnounce('Move canceled');
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (readOnly) return;
      setHeld({ id: task.id, target: Math.max(0, targets.indexOf(task.status)) });
      setAnnounce(
        `Picked up ${task.name}. Arrow keys choose a column, Space drops, Escape cancels.`,
      );
      return;
    }
    const cards = [...(board.current?.querySelectorAll<HTMLElement>('[data-board2-card]') ?? [])];
    const cur = cards.find((c) => c.dataset['board2Card'] === task.id);
    if (!cur) return;
    const col = Number(cur.dataset['col']);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sameCol = cards.filter((c) => c.dataset['col'] === String(col));
      const i = sameCol.indexOf(cur);
      sameCol[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      for (let c = col + step; c >= 0 && c < columns.length; c += step) {
        const inCol = cards.filter((x) => x.dataset['col'] === String(c));
        const target = inCol.find((x) => x.dataset['lane'] === cur.dataset['lane']) ?? inCol[0];
        if (target) {
          target.focus();
          break;
        }
      }
    }
  };

  const submitNew = () => {
    const name = newName.trim();
    if (!name || !adding) return;
    createTask.mutate({ name, duration: 1, status: adding });
    setNewName('');
    setAdding(null);
  };

  const toggleSet = (set: ReadonlySet<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  const activeFilters = Number(filter.criticalOnly) + Number(filter.blockedOnly);
  const canCompose = !readOnly;

  const toolbar = (
    <div
      className="flex w-full flex-wrap items-center gap-2"
      role="toolbar"
      aria-label="Board controls"
    >
      <Popover
        ariaLabel="Filter cards"
        label={<>Filter{activeFilters > 0 ? ` · ${activeFilters}` : ''}</>}
      >
        <MenuCheck
          checked={filter.criticalOnly}
          onChange={() => setFilter((f) => ({ ...f, criticalOnly: !f.criticalOnly }))}
        >
          Critical only
        </MenuCheck>
        <MenuCheck
          checked={filter.blockedOnly}
          onChange={() => setFilter((f) => ({ ...f, blockedOnly: !f.blockedOnly }))}
        >
          Blocked only
        </MenuCheck>
      </Popover>
      {isDesktop && (
        <button
          type="button"
          className={TOOL}
          aria-pressed={lanesOn}
          onClick={() => setLanesOn((v) => !v)}
        >
          Lanes (Phase)
        </button>
      )}
      {isDesktop && (
        <button
          type="button"
          className={TOOL}
          aria-pressed={backlogOpen}
          onClick={() => setBacklogOpen((v) => !v)}
        >
          Backlog pane
        </button>
      )}
      <Popover
        align="right"
        ariaLabel="More board options: card fields, WIP limits, collapse Done"
        label={<span aria-hidden="true">⋯</span>}
      >
        <MenuCheck checked={showFields} onChange={() => setShowFields((v) => !v)}>
          Card fields
        </MenuCheck>
        <MenuCheck checked={showWip} onChange={() => setShowWip((v) => !v)}>
          WIP limits
        </MenuCheck>
        <MenuCheck checked={doneCollapsed} onChange={() => setDoneCollapsed((v) => !v)}>
          Collapse Done
        </MenuCheck>
      </Popover>
      {canCompose && (
        <Button
          size="sm"
          className={`ml-auto ${PAGE_BUTTON}`}
          onClick={() => setAdding('NOT_STARTED')}
        >
          Add card
        </Button>
      )}
    </div>
  );

  const stale = error && tasks ? true : !online;
  const staleBanner = stale && tasks && (
    <div
      role="status"
      className="rounded-md border border-p1-hairline bg-p1-surface-2 px-3 py-2 text-sm text-p1-text-1"
    >
      Board is showing your {formatInstantTime(lastGood.current?.toISOString())} copy. Moves you
      make now are queued and sync when you reconnect.
    </div>
  );

  const header = <PageTitle visuallyHidden>Board</PageTitle>;

  if (isLoading && !tasks) {
    return (
      <PageFrame width="bleed" header={header} toolbar={toolbar} titleHidden>
        <div
          data-testid="board2-skeleton"
          aria-busy="true"
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}
        >
          {heads.map((h) => (
            <div key={h.status} className="flex flex-col gap-2">
              <ColumnHeader head={h} showWip={false} />
              <div className="h-16 animate-pulse rounded-md bg-p1-surface-2" />
              <div className="h-16 animate-pulse rounded-md bg-p1-surface-2" />
            </div>
          ))}
        </div>
      </PageFrame>
    );
  }

  if (error && !tasks) {
    return (
      <PageFrame width="bleed" header={header} titleHidden>
        <QueryErrorState
          variant="page"
          message="The board could not be loaded."
          stillWorks="Your other pages and any queued changes are unaffected."
          supportCode="BOARD-LOAD"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </PageFrame>
    );
  }

  if (all.length === 0) {
    return (
      <PageFrame width="bleed" header={header} titleHidden>
        <EmptyState
          variant="page"
          title="No cards on this board yet"
          description="Add a task and it appears here in its phase."
        />
      </PageFrame>
    );
  }

  const gridStyle = {
    gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`,
  };

  const renderCell = (
    lane: { id: string; name: string; tasks: Task[] },
    status: TaskStatus,
    ci: number,
  ) => {
    const cards = lane.tasks.filter((t) => t.status === status);
    const isDone = status === 'COMPLETE';
    const key = `${lane.id}:${status}`;
    const { shown, hidden } =
      isDone && !doneCollapsed ? splitDone(cards, doneOpen.has(key)) : { shown: cards, hidden: 0 };
    const hideAll = isDone && doneCollapsed;
    return (
      <ul
        key={status}
        aria-label={`${labelOf(status)} in ${lane.name}`}
        className="flex min-h-10 min-w-0 flex-col gap-2 rounded-md bg-p1-surface-2/40 p-1.5"
        onDragOver={(e) => canCompose && e.preventDefault()}
        onDrop={() => dragged.current && move(dragged.current, status)}
        data-testid={`board2-cell-${status}`}
      >
        {hideAll
          ? cards.length > 0 && (
              <li className="px-1 text-xs text-p1-text-2">{cards.length} done (collapsed)</li>
            )
          : shown.map((t) => (
              <Board2Card
                key={t.id}
                task={t}
                col={ci}
                laneId={lane.id}
                held={held?.id === t.id}
                draggable={!readOnly}
                showFields={showFields}
                onKeyDown={onCardKey}
                onDragStart={(task) => (dragged.current = task)}
              />
            ))}
        {hidden > 0 && (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setDoneOpen((s) => toggleSet(s, key))}
              className={`h-9 w-full rounded-md text-xs text-p1-text-2 underline hover:text-p1-text-1 max-md:h-11 ${FOCUS_RING}`}
            >
              {hidden} more done
            </button>
          </li>
        )}
      </ul>
    );
  };

  const desktopBoard = (
    <div className="flex min-w-0 gap-3">
      <div className="min-w-0 flex-1" role="group" aria-label="Board">
        <div
          role="group"
          aria-label="Columns"
          className="sticky top-0 z-10 grid gap-3 bg-p1-surface-1 py-1.5"
          style={gridStyle}
        >
          {heads.map((h) => (
            <ColumnHeader key={h.status} head={h} showWip={showWip} />
          ))}
        </div>
        {lanes.length === 0 && (
          <p className="py-6 text-sm text-p1-text-2">No cards match the filter.</p>
        )}
        {lanes.map((lane) => {
          const s = summarizeLane(lane.tasks);
          const collapsed = collapsedLanes.has(lane.id);
          const span = [fmtDay(s.start), fmtDay(s.finish)].filter(Boolean).join(' – ');
          return (
            <section
              key={lane.id}
              aria-label={`${lane.name} lane`}
              data-testid="board2-lane"
              className="mb-2"
            >
              {lanesOn && (
                <h2 className="m-0">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedLanes((c) => toggleSet(c, lane.id))}
                    className={`flex h-9 w-full items-center gap-3 rounded-md bg-p1-surface-2 px-3 text-left text-sm font-semibold text-p1-text-1 ${FOCUS_RING}`}
                  >
                    <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                    <span className="truncate">{lane.name}</span>
                    {span && <span className="font-normal text-p1-text-2">{span}</span>}
                    <span className="font-normal text-p1-text-2">{s.count} cards</span>
                    {s.critical > 0 && (
                      <span className="font-medium text-p1-critical">▲ {s.critical} critical</span>
                    )}
                  </button>
                </h2>
              )}
              {!collapsed && (
                <div className="mt-1 grid gap-3" style={gridStyle}>
                  {columns.map((c, ci) => renderCell(lane, c.status, ci))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {backlogOpen && (
        <aside
          aria-label="Backlog"
          data-testid="board2-backlog"
          className="w-[248px] shrink-0 rounded-md border border-p1-hairline p-2"
          onDragOver={(e) => canCompose && e.preventDefault()}
          onDrop={() => dragged.current && move(dragged.current, 'BACKLOG')}
        >
          <h2 className="m-0 mb-2 text-xs font-semibold text-p1-text-2">
            Backlog · {backlog.length}
          </h2>
          {backlog.length === 0 ? (
            <div
              data-testid="board2-backlog-empty"
              className="flex flex-col items-start gap-2 text-sm text-p1-text-2"
            >
              <p className="m-0">Nothing waiting. Drop a card here to unplan it.</p>
              {canCompose && (
                <Button
                  size="sm"
                  variant="secondary"
                  className={PAGE_BUTTON}
                  onClick={() => setAdding('BACKLOG')}
                >
                  Add to backlog
                </Button>
              )}
              <Link
                to={`/projects/${projectId}/settings`}
                className={`text-p1-text-1 underline ${FOCUS_RING}`}
              >
                Import tasks
              </Link>
            </div>
          ) : (
            <ul className="m-0 flex flex-col gap-2 p-0">
              {backlog.map((t) => (
                <Board2Card
                  key={t.id}
                  task={t}
                  col={-1}
                  laneId="backlog"
                  held={held?.id === t.id}
                  draggable={!readOnly}
                  showFields={showFields}
                  onKeyDown={onCardKey}
                  onDragStart={(task) => (dragged.current = task)}
                />
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );

  const phoneActive = phoneStatus ?? columns[0]?.status ?? 'NOT_STARTED';
  const phoneHead = heads.find((h) => h.status === phoneActive);
  const phoneLanes = lanes.filter((l) => phoneLane === 'all' || l.id === phoneLane);
  const phoneCards = phoneLanes.flatMap((l) => l.tasks.filter((t) => t.status === phoneActive));
  const phoneBoard = (
    <div className="flex flex-col gap-2">
      <select
        aria-label="Lane"
        value={phoneLane}
        onChange={(e) => setPhoneLane(e.target.value)}
        className={`h-11 rounded-md border border-p1-hairline bg-p1-surface-1 px-2 text-sm text-p1-text-1 ${FOCUS_RING}`}
      >
        <option value="all">All lanes</option>
        {lanes.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <div role="tablist" aria-label="Status" className="grid gap-1" style={gridStyle}>
        {heads.map((h) => (
          <button
            key={h.status}
            role="tab"
            type="button"
            aria-selected={h.status === phoneActive}
            onClick={() => setPhoneStatus(h.status)}
            className={`h-11 min-w-0 truncate rounded-full border border-p1-hairline px-2 text-xs text-p1-text-1 aria-selected:bg-p1-brand-tint ${FOCUS_RING}`}
          >
            {h.label} {h.count}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={phoneHead?.label} className="flex flex-col gap-2">
        {phoneHead && (
          <p className="m-0 text-xs text-p1-text-2">
            {phoneHead.count} cards
            {phoneHead.wipLimit != null && ` · WIP ${phoneHead.count}/${phoneHead.wipLimit}`}
            {` · ▲ ${phoneCards.filter((t) => t.isCritical).length} critical`}
          </p>
        )}
        <ul className="m-0 flex flex-col gap-2 p-0">
          {phoneCards.map((t) => (
            <Board2Card
              key={t.id}
              task={t}
              col={columns.findIndex((c) => c.status === phoneActive)}
              laneId="phone"
              held={held?.id === t.id}
              draggable={false}
              showFields={showFields}
              onKeyDown={onCardKey}
              onDragStart={() => undefined}
            />
          ))}
        </ul>
      </div>
    </div>
  );

  return (
    <PageFrame
      width="bleed"
      header={header}
      toolbar={toolbar}
      toolbarOverride={staleBanner || undefined}
      titleHidden
    >
      <div ref={board} data-testid="board2">
        {stale && tasks && <div className="mb-2">{toolbar}</div>}
        {adding && (
          <form
            aria-label="Add card"
            className="mb-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitNew();
            }}
          >
            <input
              ref={newInput}
              aria-label={adding === 'BACKLOG' ? 'New backlog card name' : 'New card name'}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
              className={`h-9 min-w-0 flex-1 rounded-md border border-p1-hairline bg-p1-surface-1 px-2 text-sm text-p1-text-1 max-md:h-11 ${FOCUS_RING}`}
            />
            <Button size="sm" type="submit" className={PAGE_BUTTON}>
              {adding === 'BACKLOG' ? 'Add to backlog' : 'Add'}
            </Button>
          </form>
        )}
        {isDesktop ? desktopBoard : phoneBoard}
        <div role="status" aria-live="polite" className="sr-only">
          {announce}
        </div>
      </div>
    </PageFrame>
  );
}
