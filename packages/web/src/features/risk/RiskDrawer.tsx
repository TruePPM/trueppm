import { useEffect, useRef, useState } from 'react';
import type { Risk } from '@/api/types';
import { RiskChip } from './RiskChip';
import { RiskForm } from './RiskForm';

export interface RiskDrawerProps {
  projectId: string;
  risk: Risk | null;
  isOpen: boolean;
  onClose: () => void;
}

// Status badge styling (outlined, rule 39)
const STATUS_CLASSES: Record<Risk['status'], string> = {
  OPEN:       'border-neutral-border text-neutral-text-secondary',
  MITIGATING: 'border-brand-primary/40 text-brand-primary',
  RESOLVED:   'border-semantic-on-track/40 text-semantic-on-track',
  ACCEPTED:   'border-semantic-at-risk/40 text-semantic-at-risk',
  CLOSED:     'border-neutral-text-disabled/40 text-neutral-text-disabled',
};

export function RiskDrawer({ projectId, risk, isOpen, onClose }: RiskDrawerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const closeButtonRef            = useRef<HTMLButtonElement>(null);
  const drawerRef                 = useRef<HTMLDivElement>(null);

  // Reset to view mode when drawer opens with a different risk
  useEffect(() => {
    if (isOpen) setIsEditing(false);
  }, [isOpen, risk?.id]);

  // Focus the close button when the drawer opens (focus trap entry point)
  useEffect(() => {
    if (isOpen) {
      // Small delay lets the CSS transition begin before moving focus
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap — keep Tab/Shift+Tab inside the drawer
  useEffect(() => {
    if (!isOpen) return undefined;

    function trapFocus(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawerRef.current) return;

      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen]);

  const isCreateMode = risk === null;
  const drawerTitle  = isCreateMode ? 'New Risk' : isEditing ? 'Edit Risk' : risk.title;

  const showForm = isCreateMode || isEditing;

  return (
    <>
      {/* Backdrop — mobile only (rule 89: desktop drawer shows alongside content) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop drawer (rule 89: right-side, 480px, slide-in from right) */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          // Desktop: right-side drawer
          'hidden md:flex fixed inset-y-0 right-0 w-[480px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          'transition-transform duration-200',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
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

      {/* Mobile bottom sheet (rule 89: 85vh, drag handle) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-xl bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
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

// Internal shared content — used in both desktop and mobile shells
interface DrawerContentProps {
  projectId: string;
  risk: Risk | null;
  isCreateMode: boolean;
  isEditing: boolean;
  drawerTitle: string;
  showForm: boolean;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
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
              className="h-8 px-3 rounded text-sm font-medium border border-neutral-border
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
            className="w-8 h-8 flex items-center justify-center rounded text-neutral-text-secondary
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
          risk && <RiskDetailView risk={risk} />
        )}
      </div>
    </>
  );
}

// Read-only detail view
function RiskDetailView({ risk }: { risk: Risk }) {
  const statusClasses = STATUS_CLASSES[risk.status];

  return (
    <div className="p-4 flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium text-neutral-text-secondary uppercase tracking-wide mb-1">
          Status
        </p>
        <span
          className={[
            'inline-flex items-center border rounded px-2 py-0.5 text-xs font-medium',
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

      <div className="text-xs text-neutral-text-secondary">
        Updated {new Date(risk.updated_at).toLocaleDateString()}
      </div>
    </div>
  );
}
