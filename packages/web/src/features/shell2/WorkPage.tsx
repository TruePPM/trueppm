import { useRef, useState, type KeyboardEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { EmptyState } from '@/components/EmptyState';
import { FolderIcon, SearchIcon } from '@/components/Icons';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SHELL_V2_FLAG } from './ShellGate';
import { useWorkModel, type WorkRow } from './workModel';

// 44px targets everywhere (rule 5). `focus:` not `focus-visible:` on a roving item,
// because focus arrives from arrow keys, which never match :focus-visible in every engine.
const ROW =
  'flex h-11 items-center gap-2 rounded-md px-3 text-sm no-underline hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset aria-[current=true]:bg-p1-brand-tint';

/**
 * Visible rows of the programs tree: every program, plus its projects unless
 * the program is collapsed. A search forces all matches visible so a hit is
 * never hidden behind a collapsed parent.
 */
export function visibleTreeRows(
  rows: ReadonlyArray<WorkRow>,
  collapsed: ReadonlySet<string>,
  searching: boolean,
): WorkRow[] {
  if (searching) return [...rows];
  return rows.filter((r) => !r.parentKey || !collapsed.has(r.parentKey));
}

/**
 * Full-page Work destination for shell v2 — the programs → projects tree, pins
 * and search from the SAME `useWorkModel` the rail's flyout reads, so the two
 * cannot disagree. Behind the `shell_v2` flag: with it off `/work` sends the
 * person to the v1 programs list.
 *
 * The tree follows the WAI-ARIA tree pattern. Each row is an `<a role="treeitem">`
 * so Enter follows it natively; exactly one row is tabbable (roving tabindex). The
 * tabbable row is derived (the remembered key if still visible, else the first), and
 * DOM focus moves only inside the key handler, never in an effect, so typing in
 * the search box above cannot have focus stolen by a re-render (rule 280).
 */
export function WorkPage() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  if (!v2) return <Navigate to="/programs" replace />;
  return <WorkPageBody />;
}

function WorkPageBody() {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const { rows, loading, failed, refetch, isEmpty } = useWorkModel(q);
  const searching = q.trim() !== '';

  const visible = visibleTreeRows(rows.programs, collapsed, searching);
  const tabbableKey = visible.some((r) => r.key === activeKey) ? activeKey : visible[0]?.key;
  const childCount = (key: string) => rows.programs.filter((r) => r.parentKey === key).length;

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setActiveKey(key);
    itemRefs.current.get(key)?.focus();
  };
  const setOpen = (key: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent, row: WorkRow) => {
    const i = visible.findIndex((r) => r.key === row.key);
    const hasKids = row.kind === 'program' && childCount(row.key) > 0;
    const expanded = hasKids && (searching || !collapsed.has(row.key));
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(visible[Math.min(i + 1, visible.length - 1)]?.key);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(visible[Math.max(i - 1, 0)]?.key);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(visible[0]?.key);
        break;
      case 'End':
        e.preventDefault();
        focusRow(visible[visible.length - 1]?.key);
        break;
      case 'ArrowRight':
        if (!hasKids) break;
        e.preventDefault();
        if (!expanded) setOpen(row.key, true);
        else focusRow(visible[i + 1]?.key);
        break;
      case 'ArrowLeft':
        if (row.parentKey) {
          e.preventDefault();
          focusRow(row.parentKey);
        } else if (expanded && !searching) {
          e.preventDefault();
          setOpen(row.key, false);
        }
        break;
    }
  };

  const sectionHead = 'px-3 pb-1 pt-4 text-xs font-medium text-p1-text-3';

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4 md:py-6">
      <h1 className="text-lg font-semibold text-p1-text-1">Work</h1>
      <label className="mt-3 flex h-11 items-center gap-2 rounded-md border border-p1-hairline bg-p1-surface-0 px-3 text-p1-text-3 focus-within:ring-2 focus-within:ring-p1-focus">
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

      {failed ? (
        <QueryErrorState
          variant="inline"
          message="Couldn't load programs and projects."
          onRetry={refetch}
        />
      ) : loading ? (
        <LoadingSkeleton label="Loading programs and projects…" variant="rows" rows={5} />
      ) : isEmpty ? (
        <EmptyState
          icon={FolderIcon}
          title="No programs or projects yet"
          description="Programs group related projects. Create one from the Programs page to see it here."
          action={
            <Link
              to="/programs"
              className="inline-flex h-11 items-center rounded-md px-3 text-sm text-p1-text-1 underline focus:outline-none focus:ring-2 focus:ring-p1-focus"
            >
              Go to Programs
            </Link>
          }
        />
      ) : (
        <>
          {rows.pinned.length > 0 && (
            <section aria-labelledby="work-pinned">
              <h2 id="work-pinned" className={sectionHead}>
                Pinned
              </h2>
              <ul>
                {rows.pinned.map((r) => (
                  <li key={r.key}>
                    <Link to={r.to} className={`${ROW} text-p1-text-2`}>
                      <span className="truncate">{r.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h2 id="work-programs" className={sectionHead}>
            Programs
          </h2>
          {visible.length === 0 ? (
            <p className="px-3 py-2 text-sm text-p1-text-3">Nothing matches.</p>
          ) : (
            <div role="tree" aria-labelledby="work-programs">
              {visible.map((r, idx) => {
                const hasKids = r.kind === 'program' && childCount(r.key) > 0;
                return (
                  <Link
                    key={r.key}
                    ref={(el) => {
                      if (el) itemRefs.current.set(r.key, el);
                      else itemRefs.current.delete(r.key);
                    }}
                    to={r.to}
                    role="treeitem"
                    aria-level={r.parentKey ? 2 : 1}
                    aria-setsize={visible.length}
                    aria-posinset={idx + 1}
                    aria-expanded={hasKids ? searching || !collapsed.has(r.key) : undefined}
                    tabIndex={r.key === tabbableKey ? 0 : -1}
                    onFocus={() => setActiveKey(r.key)}
                    onKeyDown={(e) => onKeyDown(e, r)}
                    className={`${ROW} ${r.parentKey ? 'pl-8 text-p1-text-2' : 'font-medium text-p1-text-1'}`}
                  >
                    <span className="truncate">{r.label}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
