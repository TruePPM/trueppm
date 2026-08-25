import {
  LINK_TYPE_OPTIONS,
  LAG_MIN_DAYS,
  LAG_MAX_DAYS,
  LAG_FIELD_LABEL,
  LAG_FIELD_HINT,
  LAG_UNIT_SUFFIX,
  type CanonicalLinkType,
} from './deps/linkTypes';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@/types';
import {
  formatCycleMessage,
  parseCyclicDependencyError,
  useAddDependency,
} from '@/hooks/useTaskMutations';
import { toast } from '@/components/Toast';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useProgramTaskSearch } from '@/features/programs/hooks/useProgramTaskSearch';
import { highlightSegments, prefixSegments } from '@/lib/searchHighlight';

/**
 * Schedule-canvas dependency picker (ADR-0066 Q4; cross-project ADR-0120).
 *
 * Lightweight search-and-pick modal opened from the right-click context menu's
 * "Add predecessor…" / "Add successor…" actions. NOT a reuse of Board's
 * `PredecessorsEditor` — that one is embedded inside `TaskFormModal` and
 * row-list shaped; this surface needs an open → search → pick → close flow.
 *
 * Two scopes:
 *  - **This project** (default): filters the local `allTasks` — instant, offline.
 *  - **Program** (only when `programId` is set): searches sibling projects of the
 *    same program via `useProgramTaskSearch`, so a user can gate a task against a
 *    task in another project (ADR-0120 cross-project critical path). The scope
 *    toggle is hidden entirely for a standalone project, so single-project
 *    behavior is unchanged.
 *
 * **Keyboard contract (#3024).** The search input keeps DOM focus throughout and
 * drives the list as a combobox: `↓` walks into the listbox (landing on the
 * *first* row, not the second) and moves `aria-activedescendant`, `↑` moves back
 * and steps out at the top, `Space` adds the active row and keeps the picker
 * open, `Enter` adds and closes, `Esc` closes. `Space` only commits once `↓` has
 * entered the list — until then it types, because the field is a search field.
 * That is what makes the picker multi-add from the keyboard; before it, `Enter`
 * was the only commit and it closes, so the picker was one-link-per-open by
 * construction.
 *
 * Submits via the shared `useAddDependency` hook, carrying the type and lag
 * chosen in the dialog (#3023 step 3 — it posted FS/0 unconditionally before,
 * and the drawer was the only place to change them). A cross-project
 * edge may come back `pending_acceptance` (ADR-0120 D2 consent gate); the
 * success toast reflects that. The server's cycle-detection 400 (now
 * program-scoped) surfaces inline below the result list so the user can pick a
 * different task without dismissing the modal.
 */
export interface ScheduleDependencyPickerProps {
  /** Source task — never appears in the result list. */
  task: Task;
  /** Picker mode. `predecessor` adds picked → source; `successor` adds source → picked. */
  mode: 'predecessor' | 'successor';
  /** Project UUID — invalidates the right cache key after success. */
  projectId: string;
  /**
   * Program UUID the current project belongs to, or null for a standalone
   * project. When null the scope toggle is hidden and the picker is single-
   * project only (no behavior change from before ADR-0120).
   */
  programId?: string | null;
  /** Full task list for filtering. */
  allTasks: Task[];
  /** Task ids already linked to source in this mode (excluded from results). */
  excludedIds: ReadonlySet<string>;
  /**
   * Scope tab to land on when opened. Defaults to `'project'` (unchanged
   * behavior for the right-click entry point). The drawer's Dependencies
   * section opens straight into `'program'` — a user reaching for this modal
   * from the drawer has already exhausted the inline same-project dropdown.
   */
  initialScope?: Scope;
  onClose: () => void;
}

const MAX_RESULTS = 12;

/**
 * The row cap the program task-search endpoint applies
 * (`ProgramViewSet.task_search`, `[:200]`). Mirrored here only to keep the count
 * from claiming completeness at the cap — the server stays the authority.
 */
const PROGRAM_SEARCH_CAP = 200;

type Scope = 'project' | 'program';

/** Normalized pickable row — either a local task or a sibling-project task. */
interface PickItem {
  id: string;
  name: string;
  projectId: string;
  isCross: boolean;
  /** Local-only display fields. */
  wbs?: string | null;
  status?: Task['status'];
  isMilestone?: boolean;
  /**
   * Cross-project display field — the server-formatted reference
   * (`qualified_id` ?? `short_id_display`), never the raw hex `short_id`
   * (#2671). Cross-project is exactly where the qualified form earns its
   * keep: it is what disambiguates two sibling projects' task 3.
   */
  shortId?: string;
  projectName?: string;
}

/** One project's rows in program scope, in server order. */
interface CrossGroup {
  projectId: string;
  projectName: string;
  items: PickItem[];
}

/**
 * Match a row against the query the way a planner means it (#2958).
 *
 * A leading digit is a **WBS prefix**: `1.` matches 1.1, 1.2, 1.4 and nothing
 * else. Anything else is a **name substring**: `lay` matches "Lay-down area
 * survey".
 *
 * The distinction is not cosmetic. Treating `1.` as a substring across both
 * fields returns every task whose *name* contains a 1, burying the phase the
 * planner asked for.
 */
export function matchesQuery(name: string, wbs: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  switch (matchKindFor(query)) {
    case 'none':
      return true;
    case 'wbs-prefix':
      return wbs.toLowerCase().startsWith(q);
    default:
      return name.toLowerCase().includes(q);
  }
}

/** Which field a query is asking about. `none` = no query, so nothing matched *for* a reason. */
export type MatchKind = 'none' | 'wbs-prefix' | 'name-substring';

/**
 * The field a query resolved against — the same split {@link matchesQuery}
 * filters on, exposed so a row can **mark** the hit instead of leaving the
 * planner to infer it.
 *
 * The highlight and the two-field filter are one feature, not two: without the
 * mark, a WBS-prefix hit and a name-substring hit render identically, and the
 * whole reason the picker distinguishes them is that a planner typing `1.`
 * means something different from a planner typing `lay`. Deriving the kind here
 * rather than re-testing `/^\d/` at the render site is what keeps the mark from
 * ever claiming a reason the filter did not use.
 */
export function matchKindFor(query: string): MatchKind {
  const q = query.trim();
  if (q === '') return 'none';
  return /^\d/.test(q) ? 'wbs-prefix' : 'name-substring';
}

export function ScheduleDependencyPicker({
  task,
  mode,
  projectId,
  programId,
  allTasks,
  excludedIds,
  initialScope = 'project',
  onClose,
}: ScheduleDependencyPickerProps) {
  const addDep = useAddDependency(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const canCrossProject = Boolean(programId);
  const [scope, setScope] = useState<Scope>(canCrossProject ? initialScope : 'project');
  const [search, setSearch] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [cycleMessage, setCycleMessage] = useState<string | null>(null);
  /**
   * Has the keyboard walked **into** the list? This is the whole Space
   * disambiguator (#3024).
   *
   * `false` — the caret owns the keyboard, so Space types a space. A planner
   * composing `site plan` must not add a link mid-query.
   * `true` — ↓/↑ moved into the listbox, so Space adds the active row and Enter
   * adds it and closes.
   *
   * **Only the arrow keys set it.** Hover deliberately does not: a pointer user
   * who brushes the list on the way back to the field would otherwise arm Space
   * without ever asking for it, and the next space they type would silently
   * create a dependency. It is also what `aria-activedescendant` is gated on —
   * announcing a selected option while the caret still owns the keys tells a
   * screen-reader user the arrow keys do something they do not yet do.
   */
  const [inList, setInList] = useState(false);
  /**
   * Rows linked during **this** open, kept locally because `excludedIds` is a
   * prop that cannot update until the parent's dependency query refetches.
   * Without it, Space on the same row twice posts a duplicate edge before the
   * refetch lands.
   */
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lastAddedName, setLastAddedName] = useState<string | null>(null);

  // Stable ids for the listbox/option wiring. `useId` can emit characters that
  // are legal in an id but awkward in a selector, so it is reduced to a plain
  // token before being composed into `aria-activedescendant`.
  const idBase = `dep-pick-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const listboxId = `${idBase}-listbox`;
  const countId = `${idBase}-count`;
  const optionId = useCallback((idx: number) => `${idBase}-opt-${idx}`, [idBase]);

  // Debounce the term feeding the program search so we don't fire a request per
  // keystroke; local (project-scope) filtering stays instant off `search`.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const programSearch = useProgramTaskSearch(
    scope === 'program' ? programId : null,
    scope === 'program' ? debouncedSearch : '',
    projectId,
  );

  // Focus search input on mount; respects motion preference by jumping
  // synchronously rather than scroll-into-view animation.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Trap Tab focus inside the modal panel and restore focus to the trigger on
  // close (web-rule 206 — any bare-mounted aria-modal="true" dialog must trap
  // its own focus). Declared after the input-focus effect so the trap's own
  // initial-focus is a no-op (the container already holds the focused input),
  // leaving the search input as the landing target. Escape is routed through
  // the trap (its document-level handler stopPropagation's Escape, which would
  // otherwise never reach the window keydown listener below).
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const projectItems = useMemo<PickItem[]>(() => {
    if (scope !== 'project') return [];
    const q = search.trim().toLowerCase();
    return (
      allTasks
        .filter((t) => t.id !== task.id)
        .filter((t) => !excludedIds.has(t.id) && !addedIds.has(t.id))
        // A leading digit reads as a WBS PREFIX, anything else as a name substring
        // (#2958). Typing `1.` means "everything in phase 1" — matching it as a
        // loose substring against names too would bury those rows among every task
        // whose title happens to contain a 1.
        .filter((t) => matchesQuery(t.name, t.wbs ?? '', q))
        .map<PickItem>((t) => ({
          id: t.id,
          name: t.name,
          projectId,
          isCross: false,
          wbs: t.wbs,
          status: t.status,
          isMilestone: t.isMilestone,
        }))
    );
  }, [scope, allTasks, task.id, excludedIds, addedIds, search, projectId]);

  // The list is capped, so the count has to say so (#2958). A silent
  // `.slice(0, 12)` reads as "these are all your options" — which, on a picker
  // whose whole job is finding one row among many, is the failure mode.
  const projectMatchTotal = projectItems.length;
  const shownProjectItems = useMemo(() => projectItems.slice(0, MAX_RESULTS), [projectItems]);

  const crossGroups = useMemo<CrossGroup[]>(() => {
    if (scope !== 'program') return [];
    const rows = programSearch.data ?? [];
    const byProject = new Map<string, CrossGroup>();
    for (const row of rows) {
      // The source task is same-project (excluded by the endpoint's
      // `exclude_project`), but guard anyway; and skip already-linked ids.
      if (row.id === task.id || excludedIds.has(row.id) || addedIds.has(row.id)) continue;
      let group = byProject.get(row.project_id);
      if (!group) {
        group = { projectId: row.project_id, projectName: row.project_name, items: [] };
        byProject.set(row.project_id, group);
      }
      group.items.push({
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        isCross: true,
        shortId: row.qualified_id ?? row.short_id_display ?? row.short_id,
        projectName: row.project_name,
      });
    }
    return [...byProject.values()];
  }, [scope, programSearch.data, task.id, excludedIds, addedIds]);

  // Flat list backing keyboard navigation — group order in program scope.
  const flatItems = useMemo<PickItem[]>(
    () => (scope === 'project' ? shownProjectItems : crossGroups.flatMap((g) => g.items)),
    [scope, shownProjectItems, crossGroups],
  );

  // Clamp active index when the list shrinks during typing / scope change.
  useEffect(() => {
    if (activeIdx >= flatItems.length) setActiveIdx(Math.max(0, flatItems.length - 1));
  }, [flatItems.length, activeIdx]);

  // A list that emptied underneath the caret takes the keyboard back to the
  // field — leaving `inList` true would point `aria-activedescendant` at an
  // option that no longer exists and keep Space swallowed.
  useEffect(() => {
    if (flatItems.length === 0 && inList) setInList(false);
  }, [flatItems.length, inList]);

  /**
   * The terms the next link is created with (#3023 step 3).
   *
   * **Picker-level rather than per-row, and that is not a compromise here.**
   * The picker commits exactly one link per Enter or Space, so a picker-level
   * control *is* per-link — and because the controls persist across a Space
   * multi-add, a planner can add two FS links, switch to SS, and add a third
   * without reopening. Per-row terms only become expressible when step 4 turns
   * the list into checkboxes and several links commit at once; that is the
   * change that should move these onto the row, not this one.
   *
   * Lag is held as TEXT, not a number. A number state forces a decision about
   * what the empty field means, and every answer is wrong: 0 silently rewrites
   * what the user cleared, NaN leaks into the payload, and null needs a second
   * branch at every read. Text defers it to one place — {@link parsedLag} —
   * where "empty" and "-" (mid-typing a lead) both resolve to 0.
   */
  const [depType, setDepType] = useState<CanonicalLinkType>('FS');
  const [lagText, setLagText] = useState('0');

  /**
   * The lag actually sent. Clamped to the bounds the drawer enforces, so the
   * picker cannot mint a link the surface that owns editing would refuse.
   */
  const parsedLag = useMemo(() => {
    const n = Number.parseInt(lagText, 10);
    if (Number.isNaN(n)) return 0;
    return Math.min(LAG_MAX_DAYS, Math.max(LAG_MIN_DAYS, n));
  }, [lagText]);

  const typeFieldId = `${listboxId}-type`;
  const lagFieldId = `${listboxId}-lag`;

  const submit = useCallback(
    (target: PickItem, opts?: { keepOpen?: boolean }) => {
      const keepOpen = opts?.keepOpen ?? false;
      setCycleMessage(null);
      const ends =
        mode === 'predecessor'
          ? { predecessor: target.id, successor: task.id }
          : { predecessor: task.id, successor: target.id };
      // The whole link, stated once. Before #3023 the picker posted FS/0 and
      // type and lag were editable only afterwards in the drawer, which made
      // every non-FS link a two-surface, two-mutation act.
      const payload = { ...ends, dep_type: depType, lag: parsedLag };
      addDep.mutate(payload, {
        onSuccess: (data) => {
          if (target.isCross) {
            const where = target.projectName ?? 'another project';
            if (data.pending_acceptance) {
              toast.info(`Dependency proposed — waiting for ${where} to accept`);
            } else {
              toast.success(`Linked across projects to ${target.name} in ${where}`);
            }
          }
          if (!keepOpen) {
            onClose();
            return;
          }
          // Multi-add (Space): the row has to leave the list on its own, because
          // the parent's `excludedIds` cannot refresh until its dependency query
          // refetches — and a second Space on a still-listed row would post a
          // duplicate edge. The running tally below is the only feedback a
          // same-project add produces, so it doubles as the live announcement.
          setAddedIds((prev) => new Set(prev).add(target.id));
          setLastAddedName(target.name);
        },
        onError: (err) => {
          const cyc = parseCyclicDependencyError(err);
          setCycleMessage(cyc ? formatCycleMessage(cyc) : 'Failed to add dependency. Retry?');
        },
      });
    },
    [addDep, mode, task.id, onClose, depType, parsedLag],
  );

  // Keep refs in sync for the window keydown handler.
  const submitRef = useRef<typeof submit | null>(null);
  const itemsRef = useRef<PickItem[]>([]);
  const activeIdxRef = useRef(0);
  const inListRef = useRef(false);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);
  useEffect(() => {
    itemsRef.current = flatItems;
  }, [flatItems]);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);
  useEffect(() => {
    inListRef.current = inList;
  }, [inList]);

  const switchScope = useCallback((next: Scope) => {
    setScope(next);
    setActiveIdx(0);
    setInList(false);
    setCycleMessage(null);
  }, []);

  // All keyboard interaction goes through a window-scoped listener — keeps the
  // dialog container free of inline handlers (a11y lint
  // jsx-a11y/no-noninteractive-element-interactions). The search input owns the
  // DOM focus throughout (rows are `tabIndex={-1}`), so the listbox is driven as
  // a combobox with `aria-activedescendant` rather than by moving focus.
  //
  // ←/→ switch scope (the list is vertical, so horizontal arrows are free);
  // ↓ walks into the list and then moves down; ↑ moves up and steps back **out**
  // at the top; Space adds without closing; Enter adds and closes. Escape is
  // handled by the focus trap (useFocusTrap above), which stopPropagation's it
  // before it can reach this window-level listener.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Every binding below steers the LIST, so each one belongs to the search
      // field and to nothing else. Space and Enter already carried this guard
      // (a Tabbed-to × button would otherwise commit a link); the arrows did
      // not, because until #3023 there was nothing else in the dialog to Tab
      // to. The link-terms controls change that: ↓ inside the type `<select>`
      // is how you choose SS, and ↑/↓ inside a number input is how you step the
      // lag — both would have been preventDefault()'d into moving the row caret
      // instead, silently, on the surface whose keyboard contract is the point.
      if (e.target !== inputRef.current) return;
      if (e.key === 'ArrowLeft' && canCrossProject) {
        e.preventDefault();
        switchScope('project');
        return;
      }
      if (e.key === 'ArrowRight' && canCrossProject) {
        e.preventDefault();
        switchScope('program');
        return;
      }
      if (e.key === 'ArrowDown') {
        if (itemsRef.current.length === 0) return;
        e.preventDefault();
        // The first ↓ *enters* the list on the row already highlighted — it does
        // not step past it. Advancing here is what made the shipped picker skip
        // to the second row on the very first press (#3024).
        if (!inListRef.current) {
          setInList(true);
          return;
        }
        setActiveIdx((i) => Math.min(itemsRef.current.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        if (itemsRef.current.length === 0) return;
        e.preventDefault();
        if (!inListRef.current) {
          setInList(true);
          return;
        }
        // ↑ off the first row hands the keyboard back to the search field. That
        // is the escape hatch that makes Space typable again without reaching
        // for the mouse — the disambiguation is only fair if it is reversible.
        if (activeIdxRef.current === 0) {
          setInList(false);
          return;
        }
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === ' ') {
        // Space is the multi-add commit ONLY once ↓ has moved the caret into the
        // list; otherwise it belongs to whatever the user is typing. The target
        // check keeps a Tabbed-to button's native Space activation intact — the
        // window listener would otherwise swallow it.
        if (!inListRef.current || e.target !== inputRef.current) return;
        const target = itemsRef.current[activeIdxRef.current];
        if (!target) return;
        e.preventDefault();
        submitRef.current?.(target, { keepOpen: true });
        return;
      }
      if (e.key === 'Enter') {
        // Same target guard as Space, and for a sharper reason: without it, a
        // user who Tabs to the × button and presses Enter has the native button
        // activation preventDefault()'d out from under them and gets a
        // DEPENDENCY CREATED on whatever row is highlighted — then the dialog
        // closes, so it looks like Close worked. A silent unintended write on
        // the keyboard path this contract exists to serve.
        if (e.target !== inputRef.current) return;
        e.preventDefault();
        const target = itemsRef.current[activeIdxRef.current];
        if (target) submitRef.current?.(target);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canCrossProject, switchScope]);

  const title =
    mode === 'predecessor'
      ? `Add predecessor to “${task.name}”`
      : `Add successor to “${task.name}”`;

  /**
   * How the rows in front of the user were actually selected.
   *
   * Project scope filters locally, so `matchKindFor` **is** the filter. Program
   * scope does not: the server runs `name__icontains` (or `notes__icontains`)
   * and never a WBS prefix, so deriving `wbs-prefix` from a leading digit there
   * would mark a reason nothing applied — and, because a cross-project row has
   * no WBS to mark, would silently mark nothing at all for a query like `2`.
   * A row matched only on its notes marks nothing, which is honest: the hit is
   * not in the text on screen.
   */
  const matchKind: MatchKind =
    scope === 'program'
      ? matchKindFor(search) === 'none'
        ? 'none'
        : 'name-substring'
      : matchKindFor(search);
  const addedCount = addedIds.size;

  /**
   * `N of M` — rows shown, of rows that matched and are still linkable.
   *
   * One expression for both scopes deliberately (#3024). Program scope rendered
   * no count at all, and project scope rendered a bare `4 matches` until the
   * 12-row cap bit — so the number a planner saw meant a different thing in each
   * of three situations. `N of M` means the same thing everywhere: program scope
   * is uncapped so N equals M there, which is information, not noise.
   */
  const matchTotal = scope === 'project' ? projectMatchTotal : flatItems.length;
  const shownCount = flatItems.length;
  // Program scope has no client cap, but the ENDPOINT caps at 200 rows. At the
  // cap the count would otherwise read `200 of 200` — stating completeness the
  // server never claimed, which is #2958's finding reintroduced on the other
  // scope. Detect it from the raw row count and fall back to the same
  // "keep typing" tail the project cap uses.
  const programCapped = (programSearch.data?.length ?? 0) >= PROGRAM_SEARCH_CAP;
  const countIsPartial = shownCount < matchTotal || (scope === 'program' && programCapped);

  return createPortal(
    <div className="fixed inset-0 z-[51] flex items-center justify-center">
      {/* Backdrop — separate button so the close affordance is keyboard- and
          screen-reader-accessible without bolting onClick onto a non-interactive
          parent (a11y rule jsx-a11y/click-events-have-key-events). */}
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-neutral-overlay"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative mx-3 w-full max-w-[480px] max-h-[480px] bg-neutral-surface border border-neutral-border rounded-card flex flex-col focus:outline-none"
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-neutral-border">
          <h2 className="text-sm font-medium text-neutral-text-primary truncate">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {canCrossProject && (
          <div
            role="tablist"
            aria-label="Dependency search scope"
            className="mx-4 mt-3 grid grid-cols-2 gap-1 rounded-control bg-neutral-row-hover p-1 text-xs"
          >
            <ScopeTab
              label="This project"
              selected={scope === 'project'}
              onSelect={() => switchScope('project')}
            />
            <ScopeTab
              label="Program"
              selected={scope === 'program'}
              onSelect={() => switchScope('program')}
            />
          </div>
        )}

        <div className="px-4 pt-3 pb-2">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIdx(0);
              // Typing hands the keyboard back to the caret — the list the user
              // had walked into is not the one they are now narrowing.
              setInList(false);
              setCycleMessage(null);
            }}
            placeholder={scope === 'program' ? 'Search tasks in this program…' : 'Search tasks…'}
            aria-label="Search tasks"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={flatItems.length > 0}
            aria-controls={flatItems.length > 0 ? listboxId : undefined}
            aria-activedescendant={inList && flatItems[activeIdx] ? optionId(activeIdx) : undefined}
            aria-describedby={matchTotal > 0 ? countId : undefined}
            className="w-full h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        </div>

        {/* The terms the next link carries (#3023 step 3). Placed BELOW the
            search field and ABOVE the results, because they describe the link
            that pressing Enter on a row will make — a control that changes what
            a commit does has to be visible before the commit, not discovered
            afterwards in the drawer. Both persist across a Space multi-add, so
            a run of SS links is set once rather than per row. */}
        <div className="flex items-center gap-2 px-4 pb-2">
          <label htmlFor={typeFieldId} className="text-xs text-neutral-text-secondary shrink-0">
            Link
          </label>
          <select
            id={typeFieldId}
            value={depType}
            onChange={(e) => setDepType(e.target.value as CanonicalLinkType)}
            className="text-xs border border-neutral-border rounded-control px-1.5 py-1
              bg-neutral-surface text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {LINK_TYPE_OPTIONS.map((dt) => (
              <option key={dt.value} value={dt.value}>
                {dt.label}
              </option>
            ))}
          </select>
          <input
            id={lagFieldId}
            type="number"
            value={lagText}
            min={LAG_MIN_DAYS}
            max={LAG_MAX_DAYS}
            aria-label={LAG_FIELD_LABEL}
            title={LAG_FIELD_HINT}
            onChange={(e) => setLagText(e.target.value)}
            className="w-16 text-xs border border-neutral-border rounded-control px-1.5 py-1 text-center
              bg-neutral-surface text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          />
          <span className="text-xs text-neutral-text-secondary shrink-0">{LAG_UNIT_SUFFIX}</span>
        </div>

        {matchTotal > 0 && (
          // "3 of 4" — and it is honest about the cap, so a planner who cannot
          // see the row they want knows to narrow rather than assuming it is
          // ineligible (#2958, count unified across scopes in #3024).
          // Deliberately NOT a live region. It changes on every keystroke, so
          // announcing it would speak over the field's own typing echo and over
          // the row announcement the planner is navigating by (rule 316). It
          // reaches a screen reader through the input's `aria-describedby`,
          // which is read on demand rather than shouted on change.
          <p id={countId} className="px-3 pb-1 text-xs text-neutral-text-secondary">
            {`${shownCount} of ${matchTotal} ${matchTotal === 1 ? 'match' : 'matches'}`}
            {countIsPartial ? ' — keep typing to narrow' : ''}
          </p>
        )}

        {addedCount > 0 && (
          // A Space-add keeps the modal open and silently removes the row, so
          // this line is the only confirmation the action produced — for a
          // sighted planner and, as a live region, for a screen reader.
          <p role="status" className="px-3 pb-1 text-xs text-brand-primary">
            {`Added “${lastAddedName ?? ''}” — ${addedCount} ${addedCount === 1 ? 'link' : 'links'} added`}
          </p>
        )}

        {scope === 'project' ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Task results"
            className="flex-1 overflow-y-auto px-2 pb-2"
          >
            {shownProjectItems.length === 0 ? (
              // `role="presentation"` because a bare listitem is not an allowed
              // child of a listbox, and this is copy rather than an option.
              <li role="presentation" className="py-3 px-2 text-[13px] text-neutral-text-secondary">
                No matching tasks. Try a different search.
              </li>
            ) : (
              shownProjectItems.map((item, i) => (
                <ResultRow
                  key={item.id}
                  id={optionId(i)}
                  item={item}
                  query={search}
                  matchKind={matchKind}
                  active={i === activeIdx}
                  onHover={() => setActiveIdx(i)}
                  onPick={() => submit(item)}
                />
              ))
            )}
          </ul>
        ) : (
          <ProgramResults
            listboxId={listboxId}
            optionId={optionId}
            groups={crossGroups}
            flatItems={flatItems}
            activeIdx={activeIdx}
            query={search}
            matchKind={matchKind}
            isLoading={programSearch.isLoading && debouncedSearch.trim().length > 0}
            isError={programSearch.isError}
            hasQuery={debouncedSearch.trim().length > 0}
            onHover={setActiveIdx}
            onPick={submit}
            onRetry={() => void programSearch.refetch()}
          />
        )}

        {cycleMessage && (
          <div
            role="alert"
            className="mx-4 mb-2 p-2 text-[12px] rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk"
          >
            {cycleMessage}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary tppm-mono">
          {/* The hint tracks `inList`, because "Space add" is false while the
              caret owns the keys — and nothing else on screen distinguishes the
              two states (the row highlight is honest about Enter, which does
              take row 0 with no keypresses, but says nothing about Space). */}
          {inList
            ? canCrossProject
              ? '←→ scope · ↑↓ move · Space add · Enter add & close · Esc cancel'
              : '↑↓ move · Space add · Enter add & close · Esc cancel'
            : canCrossProject
              ? '←→ scope · ↓ into list · Enter add & close · Esc cancel'
              : '↓ into list · Enter add & close · Esc cancel'}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A single tab in the scope segmented control. tabIndex -1 keeps focus on the
 *  search input; the toggle is driven by click or the ←/→ window bindings. */
function ScopeTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={[
        'h-7 rounded-control px-2 font-medium transition-colors',
        selected
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

/** Program-scope result body: grouped rows, plus loading / empty / error states. */
function ProgramResults({
  listboxId,
  optionId,
  groups,
  flatItems,
  activeIdx,
  query,
  matchKind,
  isLoading,
  isError,
  hasQuery,
  onHover,
  onPick,
  onRetry,
}: {
  listboxId: string;
  optionId: (idx: number) => string;
  groups: CrossGroup[];
  flatItems: PickItem[];
  activeIdx: number;
  query: string;
  matchKind: MatchKind;
  isLoading: boolean;
  isError: boolean;
  hasQuery: boolean;
  onHover: (idx: number) => void;
  onPick: (item: PickItem) => void;
  onRetry: () => void;
}) {
  if (!hasQuery) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        Search for a task in another project of this program to depend on.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div
        className="flex-1 overflow-y-auto px-4 pb-2 pt-1"
        aria-busy="true"
        aria-label="Loading tasks"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-9 my-1 rounded-control bg-neutral-row-hover motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        Couldn’t load program tasks.{' '}
        <button
          type="button"
          onClick={onRetry}
          className="underline text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
        >
          Retry
        </button>
      </div>
    );
  }
  if (flatItems.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        No matching tasks in this program. Try a different search.
      </div>
    );
  }
  // Map each rendered row back to its flat index for keyboard highlight.
  let flat = -1;
  return (
    // listbox → group → option. The project header is `aria-hidden` because the
    // group's own `aria-label` already carries it; a bare <div> inside a listbox
    // is not an allowed child, and duplicating the name announces it twice.
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Program task results"
      className="flex-1 overflow-y-auto px-2 pb-2"
    >
      {groups.map((group) => (
        <li key={group.projectId} role="group" aria-label={group.projectName} className="mb-1">
          <div
            aria-hidden="true"
            className="sticky top-0 z-[1] flex items-center gap-1.5 px-2 py-1 bg-neutral-surface text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
          >
            <span className="h-1.5 w-1.5 rounded-chip bg-neutral-text-disabled" />
            <span className="truncate">{group.projectName}</span>
          </div>
          <ul role="presentation">
            {group.items.map((item) => {
              flat += 1;
              const idx = flat;
              return (
                <ResultRow
                  key={item.id}
                  id={optionId(idx)}
                  item={item}
                  query={query}
                  matchKind={matchKind}
                  active={idx === activeIdx}
                  onHover={() => onHover(idx)}
                  onPick={() => onPick(item)}
                />
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders `text` with the part that matched the query wrapped in a `<mark>`.
 *
 * The anchoring follows the kind, not the field: a WBS hit is marked as a
 * **prefix** (what `matchesQuery` filtered on) and a name hit as a **substring**,
 * so the mark is always a statement about the filter that produced the row.
 */
function MatchedText({ text, query, kind }: { text: string; query: string; kind: MatchKind }) {
  const segments =
    kind === 'wbs-prefix'
      ? prefixSegments(text, query)
      : kind === 'name-substring'
        ? highlightSegments(text, query)
        : [{ text, match: false }];
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          // `bg-brand-accent-light` is a STATIC hex (#FFF3CD): it stays cream in
          // dark mode while the ink inverts to light, which is the 1.06:1 class
          // rule 86 exists for. The sage wash is mode-aware, and the explicit
          // foreground is what stops the WBS column's `text-neutral-text-disabled`
          // from being inherited onto a tinted ground (rule 87). `font-medium`
          // is the second channel, so the mark is not carried by hue alone
          // (WCAG 1.4.1) — the whole point of it is stating WHY a row matched.
          <mark
            key={index}
            className="rounded-[2px] bg-brand-primary/20 px-px font-medium text-neutral-text-primary"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One result row, shared by both scopes.
 *
 * `id` is what `aria-activedescendant` on the search input points at — the row
 * never takes DOM focus, so the id is the only thing telling a screen reader
 * which option the arrow keys are on.
 */
function ResultRow({
  id,
  item,
  query,
  matchKind,
  active,
  onHover,
  onPick,
}: {
  id: string;
  item: PickItem;
  query: string;
  matchKind: MatchKind;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const reference = item.isCross ? item.shortId || '—' : item.wbs || '—';
  // A cross-project row's reference is a server-formatted id (`SEC-3`), not a
  // WBS code — prefix semantics do not apply to it, so it is never marked.
  const markReference = matchKind === 'wbs-prefix' && !item.isCross;
  /**
   * The row's name is stated explicitly rather than computed from its contents.
   *
   * Highlighting splits a name across `<mark>`/`<span>` nodes, and accessible-name
   * computation **trims each text node before joining** — so the marked row would
   * announce "Designreview". That is not cosmetic here: this label is what
   * `aria-activedescendant` makes a screen reader read on every arrow press.
   */
  const rowLabel = [reference === '—' ? null : reference, item.name, statusChipLabel(item)]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return (
    // The option IS the control — there is no inner <button>.
    //
    // A `button` inside `role="option"` is axe's `nested-interactive` (serious):
    // ARIA 1.2 makes an option's children presentational, so the inner control's
    // role and name are dropped by conforming AT, leaving a focusable thing a
    // screen reader cannot describe. It also forced `rowLabel` to be written
    // twice, which is a drift waiting to happen. Keyboard activation is not lost
    // by dropping it: this listbox is driven by `aria-activedescendant` from the
    // search field, which owns Space and Enter — the row never takes DOM focus,
    // which is exactly why `tabIndex={-1}` was on the button in the first place.
    //
    // The lint rule below cannot see the listener because it is not on this node:
    // the window-scoped handler above owns ↑↓/Space/Enter for the whole listbox,
    // which IS the aria-activedescendant pattern (APG combobox). Satisfying the
    // rule literally means restoring the nested <button>; a no-op onKeyDown would
    // silence it while adding nothing a user can press.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard handled by the listbox's window handler (aria-activedescendant pattern)
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-label={rowLabel}
      onMouseEnter={onHover}
      onClick={onPick}
      className={[
        'w-full flex items-center gap-2 min-h-11 md:h-9 px-2 rounded-control text-left text-[13px] cursor-pointer',
        active ? 'bg-neutral-row-hover' : '',
      ].join(' ')}
    >
      <span className="tppm-mono text-xs text-neutral-text-disabled w-12 shrink-0 truncate">
        {markReference ? (
          <MatchedText text={reference} query={query} kind="wbs-prefix" />
        ) : (
          reference
        )}
      </span>
      <span className="flex-1 min-w-0 truncate text-neutral-text-primary">
        {matchKind === 'name-substring' ? (
          <MatchedText text={item.name} query={query} kind="name-substring" />
        ) : (
          item.name
        )}
      </span>
      {!item.isCross && (
        <StatusChip status={item.status ?? 'NOT_STARTED'} isMilestone={item.isMilestone ?? false} />
      )}
    </li>
  );
}

/**
 * The trailing words a row's status chip contributes to its accessible name.
 *
 * Kept beside `StatusChip` so the spoken row and the rendered row cannot drift:
 * a cross-project row renders no chip and therefore contributes nothing.
 */
function statusChipLabel(item: PickItem): string | null {
  if (item.isCross) return null;
  if (item.isMilestone ?? false) return '— milestone';
  return (item.status ?? 'NOT_STARTED').replace('_', ' ').toLowerCase();
}

/** Compact status pill matching the design system semantics. */
function StatusChip({ status, isMilestone }: { status: Task['status']; isMilestone: boolean }) {
  if (isMilestone) {
    return (
      <span className="text-xs text-neutral-text-disabled w-24 text-right shrink-0">
        — milestone
      </span>
    );
  }
  const label = status.replace('_', ' ').toLowerCase();
  return (
    <span className="text-xs text-neutral-text-secondary w-24 text-right shrink-0 truncate">
      {label}
    </span>
  );
}
