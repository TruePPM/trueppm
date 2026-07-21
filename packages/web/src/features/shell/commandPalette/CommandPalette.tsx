import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { SearchIcon } from '@/components/Icons';
import { modifierKeyLabel } from '@/lib/platform';
import { useProjectId } from '@/hooks/useProjectId';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { filterCommandItems, type CommandItem } from './commandItems';
import { useCommandItems } from './useCommandItems';

const GROUP_LABEL: Record<CommandItem['group'], string> = {
  sprint: 'Current sprint',
  sprintTask: 'Current sprint tasks',
  task: 'Tasks',
  current: 'Current project',
  person: 'People',
  epic: 'Epics',
  story: 'Stories',
  recent: 'Recent',
  jump: 'Jump to',
  backlog: 'Backlog',
  board: 'Board',
  action: 'Actions',
};
// Render + keyboard-nav order. `sprint` (jump to today's active sprint board, the
// first-class issue 1594 action) leads always; `sprintTask` (active-sprint tasks,
// ADR-0508) then `task` (all other tasks) follow — both query-gated; `current`
// (in-context role targets) then the query-gated global searches — `person`
// (people), `epic` + `story` (cross-program Epic/Story omni-search, ADR-0508 D4) —
// sit above `recent` (cold-only recently-visited projects, ADR-0508) and the global
// navigation.
const GROUP_ORDER: CommandItem['group'][] = [
  'sprint',
  'sprintTask',
  'task',
  'current',
  'person',
  'epic',
  'story',
  'recent',
  'jump',
  'backlog',
  'board',
  'action',
];

/** Calm mono chip styling per tag. Only "Sprint" (live/now) gets a brand tint;
 *  every other type stays neutral so the result list reads as one quiet column. */
const CHIP_CLASS: Record<string, string> = {
  Sprint: 'bg-brand-primary/10 text-brand-primary',
};
const DEFAULT_CHIP_CLASS = 'bg-neutral-surface-sunken text-neutral-text-secondary';

/** Max task results shown (ADR-0138) — keep the list scannable. */
const TASK_RESULT_CAP = 8;
/** Max active-sprint task results shown (ADR-0508) — a bounded working set the
 *  user recognizes, so a higher-but-still-scannable cap than project-wide tasks. */
const SPRINT_TASK_RESULT_CAP = 25;
/** Max people results shown (ADR-0401) — same scannability budget as tasks. */
const PERSON_RESULT_CAP = 6;
/** Max Epic and Story omni-search results shown (ADR-0508 D4) — the server returns
 *  a paginated page; the palette shows a scannable slice per group, same budget as
 *  people. The endpoint is the source of truth for access scope; this is display. */
const EPIC_RESULT_CAP = 6;
const STORY_RESULT_CAP = 6;

/**
 * Apply the per-section result caps to the filtered list, preserving order so the
 * flat list drives both rendering and keyboard nav identically:
 *  - `sprintTask` (active-sprint tasks, ADR-0508) are query-gated and capped at
 *    {@link SPRINT_TASK_RESULT_CAP}.
 *  - `task` (all other tasks) are query-gated (a cold palette never dumps
 *    arbitrary tasks) and capped at {@link TASK_RESULT_CAP}.
 *  - `person` are already query-gated at the hook (only built with a non-empty
 *    query) and capped at {@link PERSON_RESULT_CAP}.
 *  - `recent` are cold-only: dropped once a query is typed so the `jump` fuzzy
 *    filter alone owns search (the hook already stops building them when typing;
 *    this is the belt-and-braces enforcement of that invariant).
 * Truncation is surfaced to the user by {@link CommandPalette} via an explicit
 * "showing N" hint, so the cap is never silent (#1940).
 */
/** Per-group result cap; a group absent here is uncapped (jump/board/action). */
const RESULT_CAPS: Partial<Record<CommandItem['group'], number>> = {
  sprintTask: SPRINT_TASK_RESULT_CAP,
  task: TASK_RESULT_CAP,
  person: PERSON_RESULT_CAP,
  epic: EPIC_RESULT_CAP,
  story: STORY_RESULT_CAP,
};
/** Groups shown only once a query is typed — a cold palette never dumps them. */
const QUERY_ONLY_GROUPS = new Set<CommandItem['group']>([
  'sprintTask',
  'task',
  'epic',
  'story',
]);

/** Whether `item` survives the caps, mutating `counts` when it is kept. Drops
 *  wrong-phase items (`recent` once typing starts; query-only groups while cold)
 *  and anything over its group's cap. */
function withinResultCaps(
  item: CommandItem,
  hasQuery: boolean,
  counts: Map<CommandItem['group'], number>,
): boolean {
  const { group } = item;
  if (group === 'recent') return !hasQuery;
  if (!hasQuery && QUERY_ONLY_GROUPS.has(group)) return false;
  const cap = RESULT_CAPS[group];
  if (cap === undefined) return true;
  const seen = counts.get(group) ?? 0;
  if (seen >= cap) return false;
  counts.set(group, seen + 1);
  return true;
}

function applyResultCaps(items: CommandItem[], query: string): CommandItem[] {
  const hasQuery = query.trim().length > 0;
  const counts = new Map<CommandItem['group'], number>();
  return items.filter((item) => withinResultCaps(item, hasQuery, counts));
}

/** Per-group truncation state, threaded from {@link CommandPalette} to the results
 *  subcomponents so the "showing N" cues stay in sync with the caps.
 *  `truncatedGroups` holds every group that overflowed its {@link RESULT_CAPS}
 *  entry; `sprintTaskTotal` backs the sprint group's "N of M" total. */
interface TruncationCues {
  truncatedGroups: Set<CommandItem['group']>;
  sprintTaskTotal: number;
}

/** The "showing N" overflow hint for a capped group — sprint tasks name the total
 *  (a bounded, countable set, ADR-0508); every other capped group (task, person,
 *  epic, story) says "first N". Renders nothing when the group did not overflow. */
function GroupOverflowHint({
  group,
  truncatedGroups,
  sprintTaskTotal,
}: { group: CommandItem['group'] } & TruncationCues) {
  if (!truncatedGroups.has(group)) return null;
  if (group === 'sprintTask') {
    return (
      <p className="px-3 pb-1 pt-0.5 text-xs text-neutral-text-secondary" role="note">
        Showing {SPRINT_TASK_RESULT_CAP} of {sprintTaskTotal} — refine your search to narrow it
        down.
      </p>
    );
  }
  const cap = RESULT_CAPS[group];
  if (cap === undefined) return null;
  return (
    <p className="px-3 pb-1 pt-0.5 text-xs text-neutral-text-secondary" role="note">
      Showing first {cap} — refine your search to narrow it down.
    </p>
  );
}

/** One result row (`role="option"`). Hover moves the active selection; the tag
 *  chip and optional detail/EE badge render inline. */
function PaletteOption({
  item,
  isActive,
  onHover,
}: {
  item: CommandItem;
  isActive: boolean;
  onHover: () => void;
}) {
  return (
    <button
      id={`cmdk-opt-${item.id}`}
      role="option"
      aria-selected={isActive}
      type="button"
      // Options are driven via the input's aria-activedescendant, so they must
      // not be tab stops — otherwise Tab/Escape leave the combobox model (#2203).
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={() => item.run()}
      className={`flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm ${
        isActive ? 'bg-brand-primary/10 text-brand-primary' : 'text-neutral-text-primary'
      }`}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate">{item.label}</span>
        {item.detail && (
          <span className="tppm-mono hidden shrink-0 text-xs text-neutral-text-secondary sm:inline">
            {item.detail}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {item.gated && (
          <span className="tppm-mono rounded-chip bg-semantic-at-risk-bg px-1.5 py-0.5 text-xs text-semantic-at-risk">
            EE
          </span>
        )}
        <span
          className={`tppm-mono rounded-chip px-1.5 py-0.5 text-xs ${
            CHIP_CLASS[item.tag] ?? DEFAULT_CHIP_CLASS
          }`}
        >
          {item.tag}
        </span>
      </span>
    </button>
  );
}

/** One labelled result group (`role="group"`) — header, overflow hint, options.
 *  Renders nothing when the group has no items. */
function PaletteGroup({
  group,
  items,
  activeItem,
  onHover,
  cues,
}: {
  group: CommandItem['group'];
  items: CommandItem[];
  activeItem: CommandItem | undefined;
  onHover: (item: CommandItem) => void;
  cues: TruncationCues;
}) {
  const groupItems = items.filter((i) => i.group === group);
  if (groupItems.length === 0) return null;
  return (
    <div
      className="py-1"
      role="group"
      aria-label={GROUP_LABEL[group]}
      data-testid={`cmdk-group-${group}`}
    >
      <p className="tppm-mono px-3 py-1 text-xs uppercase tracking-wider text-neutral-text-disabled">
        {GROUP_LABEL[group]}
      </p>
      <GroupOverflowHint group={group} {...cues} />
      {groupItems.map((item) => (
        <PaletteOption
          key={item.id}
          item={item}
          isActive={item.id === activeItem?.id}
          onHover={() => onHover(item)}
        />
      ))}
    </div>
  );
}

/** The listbox body: an empty-state line, or the ordered result groups. */
function PaletteResultsBody({
  items,
  query,
  activeItem,
  onHover,
  truncatedGroups,
  sprintTaskTotal,
}: {
  items: CommandItem[];
  query: string;
  activeItem: CommandItem | undefined;
  onHover: (item: CommandItem) => void;
} & TruncationCues) {
  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-neutral-text-secondary">
        No matches for “{query}”.
      </p>
    );
  }
  const cues: TruncationCues = { truncatedGroups, sprintTaskTotal };
  return (
    <>
      {GROUP_ORDER.map((group) => (
        <PaletteGroup
          key={group}
          group={group}
          items={items}
          activeItem={activeItem}
          onHover={onHover}
          cues={cues}
        />
      ))}
    </>
  );
}

/**
 * ⌘K / Ctrl+K command palette (v2 design system). A centered overlay with a fuzzy
 * filter over Jump-to destinations (My Work, programs, projects) and global
 * Actions. Keyboard-first: ↑/↓ move, Enter runs, Esc closes. Built on the v2
 * golden tokens (shadow-pop is sanctioned for this pop surface; ADR-0126).
 *
 * Accessibility: a labelled modal dialog; the input is a combobox driving a
 * listbox via `aria-activedescendant`, so focus stays in the field while the
 * arrow keys move the visual selection (the standard combobox pattern).
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build live items only while open so the Tier-2 detail queries stay inert; the
  // query drives the server-side people tier (ADR-0401).
  const allItems = useCommandItems(open, query);
  const currentProjectId = useProjectId();

  const filtered = useMemo(() => filterCommandItems(allItems, query), [allItems, query]);
  const items = useMemo(() => applyResultCaps(filtered, query), [filtered, query]);

  // Which capped sections overflowed — drives the explicit "showing first N" hints
  // so the truncation is never silent (#1940). Computed generically from
  // {@link RESULT_CAPS} so a new capped group (epic/story, ADR-0508 D4) gets its
  // cue for free.
  const truncatedGroups = useMemo(() => {
    const overflowed = new Set<CommandItem['group']>();
    for (const [group, cap] of Object.entries(RESULT_CAPS)) {
      const g = group as CommandItem['group'];
      if (filtered.filter((i) => i.group === g).length > cap) overflowed.add(g);
    }
    return overflowed;
  }, [filtered]);
  // Total active-sprint task matches (before the cap) — drives the "Showing 25 of
  // {M}" cue, which names the total because a sprint is a bounded, countable set
  // (ADR-0508); project-wide tasks stay "first N" (no alarming unbounded total).
  const sprintTaskTotal = useMemo(
    () => filtered.filter((i) => i.group === 'sprintTask').length,
    [filtered],
  );

  // Announce the result count to SR users (#2203) — the listbox re-renders
  // silently as the query narrows. Debounced so it speaks the settled count
  // once, not on every keystroke; cleared when there is no query or the
  // palette is closed.
  const [resultsAnnouncement, setResultsAnnouncement] = useState('');
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setResultsAnnouncement('');
      return undefined;
    }
    const id = window.setTimeout(() => {
      setResultsAnnouncement(
        items.length === 0
          ? `No matches for ${q}`
          : `${items.length} result${items.length === 1 ? '' : 's'}`,
      );
    }, 300);
    return () => window.clearTimeout(id);
  }, [open, query, items.length]);

  // Reset query + selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer so the element exists and the browser doesn't scroll-jank.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Keep the active row in view as the selection moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[aria-selected="true"]');
    // Optional call: jsdom (tests) does not implement scrollIntoView.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open, items.length]);

  if (!open) return null;

  const clampedActive = Math.min(activeIndex, Math.max(items.length - 1, 0));
  const activeItem = items[clampedActive];

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activeItem?.run();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* Backdrop — click to close (mirrors the shell drawer pattern). */}
      <div
        className="absolute inset-0 bg-neutral-overlay"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-[560px] overflow-hidden rounded-card border border-neutral-border bg-neutral-surface shadow-pop motion-safe:animate-cmdk-in"
      >
        {/* Search field — owns all keyboard interaction (focus lives here). */}
        <div className="flex items-center gap-2 border-b border-neutral-border px-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-neutral-text-secondary" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeItem ? `cmdk-opt-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            placeholder="Search or jump to…"
            value={query}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            className="w-full bg-transparent py-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
          />
          <kbd className="tppm-mono shrink-0 rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs text-neutral-text-secondary">
            Esc
          </kbd>
        </div>

        {/* Off-project hint — teaches the current-project capability without nagging.
            Only shown cold (no query) when there is no project in context. */}
        {!currentProjectId && !query.trim() && (
          <p className="border-b border-neutral-border px-4 py-1.5 text-xs text-neutral-text-secondary">
            Open a project to search its tasks and sprint.
          </p>
        )}

        {/* Debounced result-count announcer (#2203) — persistent polite region. */}
        <div role="status" aria-live="polite" className="sr-only">
          {resultsAnnouncement}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="cmdk-listbox"
          role="listbox"
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          <PaletteResultsBody
            items={items}
            query={query}
            activeItem={activeItem}
            onHover={(item) => setActiveIndex(items.indexOf(item))}
            truncatedGroups={truncatedGroups}
            sprintTaskTotal={sprintTaskTotal}
          />
        </div>

        {/* Footer hint — the action verb adapts so a task open is announced as
            "open in drawer" (it does not navigate away) before the user commits. */}
        <div className="flex items-center gap-3 border-t border-neutral-border px-3 py-2 text-xs text-neutral-text-secondary">
          <span>
            <kbd className="tppm-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="tppm-mono">↵</kbd>{' '}
            {activeItem?.group === 'task' || activeItem?.group === 'sprintTask'
              ? 'open in drawer'
              : 'open'}
          </span>
          <span className="ml-auto tppm-mono">{modifierKeyLabel()}K</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
