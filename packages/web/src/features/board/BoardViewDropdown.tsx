/**
 * "View" dropdown for the board toolbar (issue #191).
 *
 * Shows built-in quick filters and user-saved named views. Selecting a view
 * applies its config to the board toolbar state. Users may save the current
 * state as a named view or delete views they created (or if Scheduler role).
 */
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { useBoardSavedViews, type BoardSavedView, type BoardViewConfig } from '@/hooks/useBoardSavedViews';

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
}

function SaveViewModal({ onSave, onCancel, isSaving }: SaveViewModalProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="absolute left-0 top-full mt-1 z-50 bg-neutral-surface border border-neutral-border rounded-card p-3 w-64"
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
      }
    );
  }

  function handleDelete(e: MouseEvent, sv: BoardSavedView) {
    e.stopPropagation();
    if (activeViewId === sv.id) onApply({}, null);
    remove.mutate(sv.id);
  }

  const btnClass =
    'border border-neutral-border rounded-control px-2 py-0.5 text-xs text-neutral-text-primary ' +
    'hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary ' +
    'focus:outline-none inline-flex items-center gap-1';

  const activeClass =
    'border-brand-primary/40 bg-brand-primary/5 text-brand-primary';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setShowSave(false); }}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${btnClass} ${activeViewId ? activeClass : ''}`}
        aria-label={`Board view: ${activeLabel}`}
      >
        {activeLabel}
        <span aria-hidden="true" className="text-neutral-text-disabled">▾</span>
      </button>

      {open && !showSave && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-50 bg-neutral-surface border border-neutral-border
            rounded-card min-w-[180px] py-1"
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
                activeViewId === bv.id ? 'text-brand-primary font-medium' : 'text-neutral-text-primary',
              ].join(' ')}
            >
              <span>{bv.label}</span>
              {activeViewId === bv.id && <span aria-hidden="true" className="text-brand-primary">✓</span>}
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
                <div
                  key={sv.id}
                  className="flex items-center group"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleSelectSaved(sv)}
                    className={[
                      'flex-1 text-left px-3 py-1.5 text-xs flex items-center gap-2',
                      'hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:outline-none',
                      activeViewId === sv.id ? 'text-brand-primary font-medium' : 'text-neutral-text-primary',
                    ].join(' ')}
                  >
                    <span className="truncate">{sv.name}</span>
                    {activeViewId === sv.id && (
                      <span aria-hidden="true" className="text-brand-primary ml-auto">✓</span>
                    )}
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
        </div>
      )}

      {showSave && (
        <SaveViewModal
          onSave={handleSave}
          onCancel={() => setShowSave(false)}
          isSaving={create.isPending}
        />
      )}
    </div>
  );
}
