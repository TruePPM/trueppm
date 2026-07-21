import { type RefObject, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Risk } from '@/api/types';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useRiskComments, useCreateRiskComment } from '@/hooks/useRisks';
import { RiskChip } from './RiskChip';
import { RiskForm } from './RiskForm';
import { RiskLinkedTasksSection } from './RiskLinkedTasksSection';

export interface RiskDrawerProps {
  projectId: string;
  risk: Risk | null;
  isOpen: boolean;
  onClose: () => void;
  /** When true, drawer opens directly in edit mode (from the ✎ quick-edit affordance). */
  initialEditing?: boolean;
}

// Status badge styling (outlined, rule 39)
const STATUS_CLASSES: Record<Risk['status'], string> = {
  OPEN:       'border-neutral-border text-neutral-text-secondary',
  MITIGATING: 'border-brand-primary/40 text-brand-primary',
  RESOLVED:   'border-semantic-on-track/40 text-semantic-on-track',
  ACCEPTED:   'border-semantic-at-risk/40 text-semantic-at-risk',
  CLOSED:     'border-neutral-text-disabled/40 text-neutral-text-disabled',
};

// Risk framework label maps — used in RiskDetailView
const CATEGORY_LABELS: Record<NonNullable<Risk['category']>, string> = {
  TECHNICAL:          'Technical',
  EXTERNAL:           'External',
  ORGANIZATIONAL:     'Organizational',
  PROJECT_MANAGEMENT: 'Project Management',
};

const RESPONSE_LABELS: Record<NonNullable<Risk['response']>, string> = {
  AVOID:    'Avoid',
  MITIGATE: 'Mitigate',
  TRANSFER: 'Transfer',
  ACCEPT:   'Accept',
};

export function RiskDrawer({ projectId, risk, isOpen, onClose, initialEditing }: RiskDrawerProps) {
  const [isEditing, setIsEditing] = useState(initialEditing ?? false);
  const closeButtonRef            = useRef<HTMLButtonElement>(null);
  // `sm` (< 768px) is the mobile bottom-sheet tier; `md`/`lg` are the desktop
  // side-by-side inspector. Rendering exactly one shell (rule 211) keeps the
  // RiskForm from being double-mounted and binds `closeButtonRef` to the copy
  // that is actually visible.
  const isMobile = useBreakpoint() === 'sm';

  const isCreateMode = risk === null;
  const drawerTitle  = isCreateMode ? 'New Risk' : isEditing ? 'Edit Risk' : risk.title;
  const showForm     = isCreateMode || isEditing;

  // Reset editing state whenever the drawer opens or the active risk changes.
  // Respects initialEditing so the ✎ quick-edit affordance opens in edit mode.
  useEffect(() => {
    if (isOpen) setIsEditing(initialEditing ?? false);
  }, [isOpen, risk?.id, initialEditing]);

  // Mobile bottom sheet is a true modal (aria-modal="true"): trap Tab, seat
  // initial focus, route Escape to close, and restore focus to the trigger.
  // `showForm` is the focusKey so swapping between the detail view and the form
  // re-seats focus instead of dropping it to <body> and letting Tab escape.
  const sheetRef = useFocusTrap<HTMLDivElement>(
    isMobile && isOpen,
    onClose,
    showForm ? 'form' : 'detail',
  );

  // Desktop panel is a NON-MODAL inspector (rule 89/264): the risk table stays
  // interactive beside it, so focus must be free to Tab back out to the table.
  // We seat initial focus on the close button and let Escape dismiss, but we
  // deliberately do NOT trap Tab — a document-level Tab trap here was the #2148
  // inverse bug that broke the side-by-side reference flow.
  useEffect(() => {
    if (isMobile || !isOpen) return undefined;
    // Small delay lets the CSS transition begin before moving focus.
    const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [isMobile, isOpen]);

  useEffect(() => {
    if (isMobile || !isOpen) return undefined;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, isOpen, onClose]);

  if (isMobile) {
    return (
      <>
        {/* Backdrop — mobile only (rule 89: desktop inspector shows alongside content) */}
        {isOpen && (
          <div
            className="fixed inset-0 bg-black/30 z-30"
            aria-hidden="true"
            onClick={onClose}
          />
        )}

        {/* Mobile bottom sheet (rule 89: 85vh, drag handle) — modal, focus-trapped */}
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label={drawerTitle}
          tabIndex={-1}
          className={[
            'fixed inset-x-0 bottom-0 z-40',
            'rounded-t-card bg-neutral-surface border-t border-neutral-border',
            'h-[85vh] flex flex-col focus:outline-none',
            'transition-transform duration-200',
            isOpen ? 'translate-y-0' : 'translate-y-full',
          ].join(' ')}
        >
          {/* Drag handle */}
          <div className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-4 shrink-0" aria-hidden="true" />
          <DrawerContent
            projectId={projectId}
            risk={risk}
            isCreateMode={isCreateMode}
            isEditing={isEditing}
            drawerTitle={drawerTitle}
            showForm={showForm}
            closeButtonRef={closeButtonRef}
            onClose={onClose}
            onEdit={() => setIsEditing(true)}
            onFormSuccess={() => { setIsEditing(false); onClose(); }}
            onFormCancel={() => setIsEditing(false)}
          />
        </div>
      </>
    );
  }

  // Desktop inline panel — rendered as a flex sibling by RiskRegisterView so it
  // lays out alongside the table column. Non-modal: no backdrop, no Tab trap.
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={drawerTitle}
      className="flex w-[480px] shrink-0 flex-col bg-neutral-surface border-l border-neutral-border overflow-y-auto"
    >
      <DrawerContent
        projectId={projectId}
        risk={risk}
        isCreateMode={isCreateMode}
        isEditing={isEditing}
        drawerTitle={drawerTitle}
        showForm={showForm}
        closeButtonRef={closeButtonRef}
        onClose={onClose}
        onEdit={() => setIsEditing(true)}
        onFormSuccess={() => { setIsEditing(false); onClose(); }}
        onFormCancel={() => setIsEditing(false)}
      />
    </div>
  );
}

// Internal shared content — used in both desktop and mobile shells
interface DrawerContentProps {
  projectId: string;
  risk: Risk | null;
  isCreateMode: boolean;
  isEditing: boolean;
  drawerTitle: string;
  showForm: boolean;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onEdit: () => void;
  onFormSuccess: () => void;
  onFormCancel: () => void;
}

function DrawerContent({
  projectId,
  risk,
  isCreateMode,
  isEditing,
  drawerTitle,
  showForm,
  closeButtonRef,
  onClose,
  onEdit,
  onFormSuccess,
  onFormCancel,
}: DrawerContentProps) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-neutral-border shrink-0">
        <h2 className="text-base font-semibold text-neutral-text-primary truncate pr-2">
          {drawerTitle}
        </h2>
        <div className="flex items-center gap-2">
          {!isCreateMode && !isEditing && (
            <button
              type="button"
              onClick={onEdit}
              className="h-8 px-3 rounded-control text-sm font-medium border border-neutral-border
                text-neutral-text-secondary hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Edit
            </button>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {showForm ? (
          <RiskForm
            projectId={projectId}
            risk={risk ?? undefined}
            onSuccess={onFormSuccess}
            onCancel={isCreateMode ? onClose : onFormCancel}
          />
        ) : (
          risk && <RiskDetailView projectId={projectId} risk={risk} onClose={onClose} />
        )}
      </div>
    </>
  );
}

// Read-only detail view
function RiskDetailView({
  projectId,
  risk,
  onClose,
}: {
  projectId: string;
  risk: Risk;
  onClose: () => void;
}) {
  const statusClasses = STATUS_CLASSES[risk.status];
  const hasPmiFields  = !!(risk.category || risk.response || risk.mitigation_due_date || risk.trigger || risk.contingency);

  return (
    <div className="p-4 flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
          Status
        </p>
        <span
          className={[
            'inline-flex items-center border rounded-chip px-2 py-0.5 text-xs font-medium',
            statusClasses,
          ].join(' ')}
        >
          {risk.status}
        </span>
      </div>

      <div>
        <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
          Severity
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-text-secondary">
            P{risk.probability} × I{risk.impact} = {risk.severity}
          </span>
          <RiskChip severity={risk.severity} />
        </div>
      </div>

      {risk.description && (
        <div>
          <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
            Description
          </p>
          <p className="text-sm text-neutral-text-primary whitespace-pre-wrap">
            {risk.description}
          </p>
        </div>
      )}

      {/* Risk framework fields — shown when at least one is populated */}
      {hasPmiFields && (
        <div className="flex flex-col gap-4 border-t border-neutral-border pt-4">
          {risk.category && (
            <div>
              <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
                Category
              </p>
              <span className="inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-medium
                bg-neutral-surface-raised text-neutral-text-secondary border border-neutral-border">
                {CATEGORY_LABELS[risk.category]}
              </span>
            </div>
          )}

          {risk.response && (
            <div>
              <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
                Response
              </p>
              {/* Filled pill — visually distinct from the outlined Status pill (ADR-0043) */}
              <span className="inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-medium
                bg-brand-primary/10 text-brand-primary border border-brand-primary/20">
                {RESPONSE_LABELS[risk.response]}
              </span>
            </div>
          )}

          {risk.mitigation_due_date && (
            <div>
              <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
                Mitigation Due
              </p>
              <span className="text-sm text-neutral-text-primary tppm-mono">
                {new Date(`${risk.mitigation_due_date}T00:00:00Z`).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
                })}
              </span>
            </div>
          )}

          {risk.trigger && (
            <div>
              <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
                Trigger
              </p>
              <p className="text-sm text-neutral-text-primary whitespace-pre-wrap">{risk.trigger}</p>
            </div>
          )}

          {risk.contingency && (
            <div>
              <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
                Contingency
              </p>
              <p className="text-sm text-neutral-text-primary whitespace-pre-wrap">{risk.contingency}</p>
            </div>
          )}
        </div>
      )}

      {/* Linked tasks (#2156) — the risk → mitigation-work handoff */}
      <RiskLinkedTasksSection projectId={projectId} risk={risk} onCloseDrawer={onClose} />

      {/* Notes (comments) — collapsible, expanded when ≥ 1 comment */}
      <RiskNotesSection projectId={projectId} riskId={risk.id} />

      <div className="text-xs text-neutral-text-secondary">
        Updated {new Date(risk.updated_at).toLocaleDateString()}
      </div>
    </div>
  );
}

// Notes section — append-only comments with author attribution (ADR-0044, issue #244)
function RiskNotesSection({ projectId, riskId }: { projectId: string; riskId: string }) {
  const { comments, isLoading } = useRiskComments(projectId, riskId);
  const createComment           = useCreateRiskComment();
  const [open, setOpen]         = useState(false);
  const [message, setMessage]   = useState('');
  const [submitError, setSubmitError] = useState('');
  const isOnline = navigator.onLine;

  // Auto-expand when comments arrive
  useEffect(() => {
    if (comments.length > 0) setOpen(true);
  }, [comments.length]);

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!message.trim()) return;
    setSubmitError('');
    createComment.mutate(
      { projectId, riskId, message: message.trim() },
      {
        onSuccess: () => setMessage(''),
        onError: () => setSubmitError('Failed to post note. Please try again.'),
      },
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="border-t border-neutral-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between text-xs font-medium
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 rounded-control"
      >
        <span>Notes {!isLoading && comments.length > 0 ? `(${comments.length})` : ''}</span>
        <svg
          className={`w-4 h-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {/* Comment list */}
          {isLoading && (
            <div className="h-8 rounded-card motion-safe:animate-pulse bg-neutral-border/30" aria-hidden="true" />
          )}
          {!isLoading && comments.length === 0 && (
            <p className="text-xs text-neutral-text-disabled">No notes yet.</p>
          )}
          {!isLoading && comments.map((c) => {
            const initials = c.author
              ? c.author.display_name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
              : '?';
            return (
              <div key={c.id} className="flex gap-2 items-start">
                <span
                  className="flex-shrink-0 w-6 h-6 rounded-full bg-neutral-surface-sunken
                    border border-neutral-border flex items-center justify-center
                    text-xs font-semibold text-neutral-text-secondary"
                  aria-hidden="true"
                >
                  {initials}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-medium text-neutral-text-primary">
                      {c.author?.display_name ?? 'Unknown'}
                    </span>
                    <time
                      dateTime={c.created_at}
                      className="text-xs text-neutral-text-disabled tppm-mono"
                    >
                      {new Date(c.created_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric',
                        minute: '2-digit', hour12: true,
                      })}
                    </time>
                  </div>
                  <p className="text-sm text-neutral-text-primary whitespace-pre-wrap mt-0.5">
                    {c.message}
                  </p>
                </div>
              </div>
            );
          })}

          {/* Add note form */}
          {!isOnline ? (
            <p className="text-xs text-neutral-text-disabled italic">
              Notes require a connection.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-2 mt-1">
              <textarea
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="Add a note"
                placeholder="Add a note…"
                disabled={createComment.isPending}
                className="w-full border border-neutral-border rounded-control px-3 py-2
                  bg-neutral-surface text-neutral-text-primary text-sm resize-none
                  placeholder:text-neutral-text-secondary
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  disabled:opacity-50"
              />
              {submitError && (
                <p role="alert" className="text-xs text-semantic-critical">{submitError}</p>
              )}
              <button
                type="submit"
                disabled={createComment.isPending || !message.trim()}
                className="self-end h-8 px-3 rounded-control text-xs font-medium
                  bg-brand-primary border border-brand-primary-dark text-neutral-text-inverse
                  hover:bg-brand-primary-dark
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  disabled:opacity-50"
              >
                {createComment.isPending ? 'Posting…' : 'Add note'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
