/**
 * Notice + repair for a saved view that filters on a label the project no
 * longer has (#2394, frame D2).
 *
 * The failure this exists to prevent is silent: #2385 made a saved label filter
 * *persist*, which means a view can now carry an id whose label was deleted
 * afterwards. The board then shows more rows than the view promises, and
 * nothing on screen says why. A filter that is not being applied must never
 * look like one that is.
 *
 * Three exits, in the order a user actually wants them:
 *   - **Remove it from this view** — accept the deletion, drop just that id.
 *   - **Create a replacement label** — re-establish the filter going forward.
 *   - **Keep for now** — dismiss the message, change nothing.
 *
 * `Keep for now` is non-destructive in the strict sense: the stored config is
 * **not** rewritten, so the dangling id survives a reload and the view can still
 * be repaired later (or by someone else). Only the first two actions write.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { compareCodeUnits } from '@/lib/compareStrings';
import { toast } from '@/components/Toast';
import { useCreateLabel } from '@/hooks/useLabels';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';
import { DeletedLabelChip } from '@/components/filters/DeletedLabelChip';

/** Dismissals are per view + per browser; nothing about them is shared. */
const DISMISS_KEY = 'trueppm.board.deletedLabelNotice.dismissed';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Keyed on view **and** the specific missing ids, so a view that later loses a
 * *different* label speaks up again instead of inheriting an old dismissal.
 *
 * The sort canonicalizes the id set so `[a, b]` and `[b, a]` yield one key — it
 * is not an alphabetical ordering anyone reads. `compareCodeUnits`, never
 * `localeCompare`: this key is persisted and later compared for exact equality,
 * so a collation that shifts with the user's locale or a browser's ICU version
 * would produce a second key for the same set and silently resurrect a notice
 * the user already dismissed.
 */
export function dismissKeyFor(viewId: string, missingIds: string[]): string {
  return `${viewId}:${[...missingIds].sort(compareCodeUnits).join(',')}`;
}

export function isNoticeDismissed(viewId: string, missingIds: string[]): boolean {
  return readDismissed().includes(dismissKeyFor(viewId, missingIds));
}

function persistDismissal(key: string): void {
  try {
    const next = [...new Set([...readDismissed(), key])];
    // Bounded: this is a convenience record, not history worth growing forever.
    localStorage.setItem(DISMISS_KEY, JSON.stringify(next.slice(-50)));
  } catch {
    // A full or unavailable localStorage must not break the board.
  }
}

interface DeletedLabelNoticeProps {
  projectId: string;
  viewId: string;
  viewName: string;
  config: BoardViewConfig;
  missingIds: string[];
  /** Rows currently shown vs. the unfiltered total, for the consequence line. */
  matchCount: number;
  totalCount: number;
  /** Persist a repaired config for this view. */
  onRepair: (config: BoardViewConfig) => void;
  isRepairing: boolean;
}

export function DeletedLabelNotice({
  projectId,
  viewId,
  viewName,
  config,
  missingIds,
  matchCount,
  totalCount,
  onRepair,
  isRepairing,
}: DeletedLabelNoticeProps) {
  const [dismissed, setDismissed] = useState(() => isNoticeDismissed(viewId, missingIds));
  const [naming, setNaming] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState('');
  const createLabel = useCreateLabel(projectId);

  // Focus the field when it appears rather than `autoFocus`: the input is
  // revealed by a click, so moving focus is a *response* to the user's action
  // (not a page-load focus steal), and doing it here keeps the a11y lint rule
  // meaningful for the cases it is actually guarding against.
  useEffect(() => {
    if (naming) nameInputRef.current?.focus();
  }, [naming]);

  if (dismissed || missingIds.length === 0) return null;

  const remaining = (config.filters?.labels ?? []).filter((id) => !missingIds.includes(id));

  function handleRemove() {
    onRepair({
      ...config,
      filters: {
        ...(config.filters ?? { assignees: [], priority: [], due: [], labels: [] }),
        labels: remaining,
      },
    });
    toast.info(`Removed the deleted label filter from "${viewName}"`);
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    createLabel.mutate(
      // Always the CURRENT project — a replacement is a new label here, never a
      // resurrection of whatever project the dangling id belonged to.
      { name, color: 'slate' },
      {
        onSuccess: (label) => {
          onRepair({
            ...config,
            filters: {
              ...(config.filters ?? { assignees: [], priority: [], due: [], labels: [] }),
              labels: [...remaining, label.id],
            },
          });
          setNaming(false);
          setNewName('');
          toast.info(`Created "${name}" and pointed "${viewName}" at it`);
        },
        onError: () => toast.error(`Couldn't create "${name}" — try again.`),
      },
    );
  }

  function handleKeep() {
    persistDismissal(dismissKeyFor(viewId, missingIds));
    setDismissed(true);
  }

  return (
    <div
      // `status`, not `alert`: this is a condition of the view the user just
      // opened, not an interruption — `alert` would preempt whatever a screen
      // reader was mid-sentence on.
      role="status"
      data-testid="deleted-label-notice"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-semantic-at-risk/40
        bg-semantic-at-risk-bg px-3 py-2 text-xs text-neutral-text-primary"
    >
      <span className="flex items-center gap-2">
        {missingIds.map((id) => (
          <DeletedLabelChip key={id} id={id} />
        ))}
      </span>
      <span className="min-w-0 flex-1">{noticeSentence(missingIds.length)}</span>
      {/* States the consequence in the same units the user is looking at, so
          "why am I seeing 214 rows" is answered without a second thought. */}
      <span className="tppm-mono shrink-0 tabular-nums text-neutral-text-secondary">
        {matchCount} of {totalCount} rows · label filter not applied
      </span>

      {naming ? (
        <span className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor={`replacement-label-${viewId}`}>
            Name for the replacement label
          </label>
          <input
            id={`replacement-label-${viewId}`}
            ref={nameInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') setNaming(false);
            }}
            placeholder="Label name"
            className="h-7 w-36 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs
              focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
          <NoticeAction onClick={handleCreate} disabled={!newName.trim() || createLabel.isPending}>
            {createLabel.isPending ? 'Creating…' : 'Create'}
          </NoticeAction>
          <NoticeAction onClick={() => setNaming(false)}>Cancel</NoticeAction>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-2">
          <NoticeAction onClick={handleRemove} disabled={isRepairing}>
            Remove it from this view
          </NoticeAction>
          {/* Not "Re-create the label": the old name is unknowable (the catalog
              omits deleted rows), so this creates a NEW label the user names. */}
          <NoticeAction onClick={() => setNaming(true)}>Create a replacement label</NoticeAction>
          <NoticeAction onClick={handleKeep}>Keep for now</NoticeAction>
        </span>
      )}
    </div>
  );
}

/**
 * Built as one string rather than interleaved JSX so the singular and plural
 * readings are both legible here, instead of being reassembled from four
 * inline ternaries at the call site.
 */
function noticeSentence(count: number): string {
  return count === 1
    ? "One filter in this view no longer exists. The label was deleted from this project, so it isn't being applied. Your other filters are unchanged."
    : `${count} filters in this view no longer exist. Those labels were deleted from this project, so they aren't being applied. Your other filters are unchanged.`;
}

function NoticeAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-control underline underline-offset-2 hover:no-underline disabled:opacity-50
        focus:outline-none focus:ring-2 focus:ring-brand-primary"
    >
      {children}
    </button>
  );
}
