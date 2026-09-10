/**
 * "View" dropdown for the board toolbar (issue #191).
 *
 * Shows built-in quick filters and user-saved named views. Selecting a view
 * applies its config to the board toolbar state. Users may save the current
 * state as a named view or delete views they created (or if Scheduler role).
 *
 * Both popovers (the menu and the "Save current view" form) are positioned via
 * the shared `useAnchoredPopover` hook (rule 260): portaled to `document.body`,
 * `position: fixed`, flipped/clamped against the viewport. The old in-flow
 * `absolute left-0` never escaped a clipping ancestor and never accounted for
 * the viewport, so a trigger near the right edge of the toolbar clipped this
 * menu's content instead of flipping/clamping (#3703).
 */
import {
  type CSSProperties,
  type MouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  useBoardSavedViews,
  type BoardSavedView,
  type BoardViewConfig,
} from '@/hooks/useBoardSavedViews';
import { CheckIcon } from '@/components/Icons';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { useLabels } from '@/hooks/useLabels';
import { labelDotStyle } from '@/lib/labelColors';
import { DeletedLabelChip } from '@/components/filters/DeletedLabelChip';
import { savedViewAriaLabel, summarizeSavedView } from './savedViewSummary';

// ---------------------------------------------------------------------------
// Built-in views
// ---------------------------------------------------------------------------

interface BuiltinView {
  id: string;
  label: string;
  config: Partial<BoardViewConfig>;
  /** Tooltip explaining what the view does */
  description: string;
}

const BUILTIN_VIEWS: BuiltinView[] = [
  {
    id: 'at-risk',
    label: '⚠ At risk',
    config: { riskLinkedOnly: true },
    description: 'Tasks with linked risks (open or mitigating)',
  },
  {
    id: 'critical-path',
    label: '🔴 Critical path',
    config: { cpOnly: true },
    description: 'Tasks on the critical path only',
  },
  {
    id: 'this-week',
    label: '📅 This week',
    config: { dueSoonDays: 7 },
    description: 'Tasks finishing within the next 7 days',
  },
  {
    id: 'my-work',
    label: '👤 My work',
    config: { assigneeFilter: 'me' },
    description: 'Tasks assigned to you',
  },
];

// ---------------------------------------------------------------------------
// SaveViewModal — inline popover to name a new view
// ---------------------------------------------------------------------------

interface SaveViewModalProps {
  onSave: (name: string) => void;
  onCancel: () => void;
  isSaving: boolean;
  popoverRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
}

function SaveViewModal({ onSave, onCancel, isSaving, popoverRef, style }: SaveViewModalProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      ref={popoverRef}
      style={style}
      className="z-50 bg-neutral-surface border border-neutral-border rounded-card p-3 overflow-y-auto"
      role="dialog"
      aria-label="Save current view"
      aria-modal="false"
    >
      <p className="text-xs font-medium text-neutral-text-primary mb-2">Save current view</p>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onSave(name.trim());
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="View name…"
        maxLength={64}
        className="w-full border border-neutral-border rounded-control px-2 py-1 text-xs text-neutral-text-primary
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none mb-2"
        aria-label="View name"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="border border-neutral-border rounded-control px-2 py-0.5 text-xs text-neutral-text-secondary
            hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:outline-none"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim() || isSaving}
          onClick={() => name.trim() && onSave(name.trim())}
          className="border border-brand-primary/40 rounded-control px-2 py-0.5 text-xs text-brand-primary
            hover:bg-brand-primary/5 focus:ring-2 focus:ring-brand-primary focus:outline-none
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * The filter summary under a saved view's name (#2394, frame D1).
 *
 * Without it, choosing a saved view is a guess: the name is whatever the author
 * typed, and the only way to learn what "Q3 triage" filters is to apply it and
 * read the chips. The line is aria-hidden — the row's own accessible name
 * carries the same content as text, so announcing it twice would make every
 * arrow-key step through the menu twice as long.
 */
function SavedViewMeta({ summary }: { summary: ReturnType<typeof summarizeSavedView> }) {
  if (summary.isEmpty) return null;
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-normal
        text-neutral-text-secondary"
    >
      {summary.segments.map((seg, i) => (
        <span key={seg}>
          {i > 0 && <span className="mr-1.5">·</span>}
          {seg}
        </span>
      ))}
      {summary.labels.map((l) =>
        l.name === null ? (
          <DeletedLabelChip key={l.id} id={l.id} variant="menu" />
        ) : (
          <span key={l.id} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 shrink-0 rounded-full" style={labelDotStyle(l.color)} />
            {l.name}
          </span>
        ),
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BoardViewDropdown
// ---------------------------------------------------------------------------

interface BoardViewDropdownProps {
  projectId: string;
  currentConfig: BoardViewConfig;
  activeViewId: string | null;
  /** Called when a view is selected; null to clear active view */
  onApply: (config: Partial<BoardViewConfig>, viewId: string | null) => void;
  currentUserId?: string | null;
}

export function BoardViewDropdown({
  projectId,
  currentConfig,
  activeViewId,
  onApply,
  currentUserId,
}: BoardViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { views, create, remove } = useBoardSavedViews(projectId || null);
  // The project's label catalog — the ONLY source used to resolve a saved
  // view's label ids to names. Deliberately not the board's card-derived
  // `labelNameById`: that map omits live labels no visible card carries, so it
  // cannot tell "deleted" from "unused" (see savedViewSummary).
  const { data: labelCatalog } = useLabels(projectId || undefined);

  const summaryOf = (sv: BoardSavedView) => summarizeSavedView(sv.config, labelCatalog);

  const activeBuiltin = BUILTIN_VIEWS.find((v) => v.id === activeViewId);
  const activeSaved = views.find((v) => v.id === activeViewId);
  const activeLabel = activeBuiltin?.label ?? activeSaved?.name ?? 'View';

  function handleSelectBuiltin(bv: BuiltinView) {
    onApply(bv.config, bv.id);
    setOpen(false);
  }

  function handleSelectSaved(sv: BoardSavedView) {
    onApply(sv.config, sv.id);
    setOpen(false);
  }

  function handleClearView() {
    onApply({}, null);
    setOpen(false);
  }

  function handleSave(name: string) {
    create.mutate(
      { name, config: currentConfig },
      {
        onSuccess: (view) => {
          onApply(view.config, view.id);
          setShowSave(false);
          setOpen(false);
        },
      },
    );
  }

  function handleDelete(e: MouseEvent, sv: BoardSavedView) {
    e.stopPropagation();
    if (activeViewId === sv.id) onApply({}, null);
    remove.mutate(sv.id);
  }

  // Portal + fixed-position + flip/clamp so both popovers escape any
  // `overflow-hidden` ancestor and never clip against the viewport edge (rule
  // 260, #3703) — replaces the old in-flow `absolute left-0`. Two hook
  // instances (one per popover) share the same trigger via a merged ref below,
  // since the menu and the save form are mutually exclusive.
  const menuEstimatedHeight = Math.min(
    480,
    64 + BUILTIN_VIEWS.length * 32 + views.length * 44 + (activeViewId ? 32 : 0),
  );
  const {
    triggerRef: popoverTriggerRef,
    popoverRef,
    popoverStyle,
  } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>({
    open: open && !showSave,
    width: 220,
    estimatedHeight: menuEstimatedHeight,
    align: 'left',
  });
  const {
    triggerRef: saveTriggerRef,
    popoverRef: savePopoverRef,
    popoverStyle: savePopoverStyle,
  } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>({
    open: showSave,
    width: 256,
    estimatedHeight: 160,
    align: 'left',
  });

  const btnClass =
    'border border-neutral-border rounded-control px-2 py-0.5 text-xs text-neutral-text-primary ' +
    'hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary ' +
    'focus:outline-none inline-flex items-center gap-1';

  const activeClass = 'border-brand-primary/40 bg-brand-primary/5 text-brand-primary';

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={(node) => {
          // The menu and the save form share one trigger — a merged callback
          // ref, since an element takes one `ref` (rule 368(c)).
          popoverTriggerRef.current = node;
          saveTriggerRef.current = node;
        }}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setShowSave(false);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${btnClass} ${activeViewId ? activeClass : ''}`}
        aria-label={`Board view: ${activeLabel}`}
      >
        {activeLabel}
        <span aria-hidden="true" className="text-neutral-text-disabled">
          ▾
        </span>
      </button>

      {open &&
        !showSave &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            role="menu"
            className="z-50 bg-neutral-surface border border-neutral-border rounded-card overflow-y-auto py-1"
          >
            {/* Clear selection */}
            {activeViewId && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleClearView}
                  className="w-full text-left px-3 py-1.5 text-xs text-neutral-text-secondary
                  hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary
                  focus:outline-none"
                >
                  Clear view
                </button>
                <hr className="border-neutral-border my-1" />
              </>
            )}

            {/* Built-in views */}
            <p className="px-3 py-0.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
              Quick filters
            </p>
            {BUILTIN_VIEWS.map((bv) => (
              <button
                key={bv.id}
                type="button"
                role="menuitem"
                onClick={() => handleSelectBuiltin(bv)}
                title={bv.description}
                className={[
                  'w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2',
                  'hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:outline-none',
                  activeViewId === bv.id
                    ? 'text-brand-primary font-medium'
                    : 'text-neutral-text-primary',
                ].join(' ')}
              >
                <span>{bv.label}</span>
                {activeViewId === bv.id && (
                  <CheckIcon
                    className="text-brand-primary inline-block h-3 w-3 align-[-0.125em]"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}

            {/* Saved views */}
            {views.length > 0 && (
              <>
                <hr className="border-neutral-border my-1" />
                <p className="px-3 py-0.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                  Saved views
                </p>
                {views.map((sv) => (
                  <div key={sv.id} className="flex items-center group">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleSelectSaved(sv)}
                      aria-label={savedViewAriaLabel(sv.name, summaryOf(sv))}
                      className={[
                        'flex-1 text-left px-3 py-1.5 text-xs flex flex-col items-stretch',
                        'hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:outline-none',
                        activeViewId === sv.id
                          ? 'text-brand-primary font-medium'
                          : 'text-neutral-text-primary',
                      ].join(' ')}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate">{sv.name}</span>
                        {activeViewId === sv.id && (
                          <CheckIcon
                            className="text-brand-primary ml-auto inline-block h-3 w-3 align-[-0.125em]"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <SavedViewMeta summary={summaryOf(sv)} />
                    </button>
                    {/* Delete — shown on hover; always visible for creator */}
                    {(sv.createdBy === currentUserId || !sv.createdBy) && (
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, sv)}
                        aria-label={`Delete view "${sv.name}"`}
                        className="px-2 py-1.5 text-neutral-text-disabled opacity-0 group-hover:opacity-100
                        hover:text-semantic-critical focus:opacity-100
                        focus:ring-2 focus:ring-brand-primary focus:outline-none
                        transition-opacity"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Save current view */}
            <hr className="border-neutral-border my-1" />
            <button
              type="button"
              role="menuitem"
              onClick={() => setShowSave(true)}
              className="w-full text-left px-3 py-1.5 text-xs text-neutral-text-secondary
              hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary
              focus:outline-none"
            >
              + Save current view…
            </button>
          </div>,
          document.body,
        )}

      {showSave &&
        savePopoverStyle &&
        createPortal(
          <SaveViewModal
            onSave={handleSave}
            onCancel={() => setShowSave(false)}
            isSaving={create.isPending}
            popoverRef={savePopoverRef}
            style={savePopoverStyle}
          />,
          document.body,
        )}
    </div>
  );
}
