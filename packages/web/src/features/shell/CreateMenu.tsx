import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN, canEditTask } from '@/lib/roles';
import { PlusIcon } from '@/components/Icons';
import { useCreateIntentStore, type CreateIntent } from '@/stores/createIntentStore';
import { resolveCreateTargets, type CreateTarget, type CreateTargetKind } from './createTargets';

const TRIGGER =
  'hidden md:inline-flex shrink-0 items-center gap-1 h-8 px-2.5 rounded-control border border-chrome-border/15 text-sm font-medium text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface';

/**
 * Context-aware, role-aware "+ New" affordance for the v2 ContextBar (ADR-0130,
 * 1179). Resolves the create target(s) from the current route, hides itself when
 * the user can't create (RBAC) or no target resolves, and publishes a `CreateIntent`
 * the dispatcher / backlog page consumes. Never pre-assigns a sprint (sprint-safe).
 */
export function CreateMenu() {
  const { pathname } = useLocation();
  const projectId = useProjectId();
  const programId = useProgramId();
  const open = useCreateIntentStore((s) => s.open);

  // All gate hooks are called unconditionally (React rules); only the relevant
  // ones are consulted per resolved target.
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const canBacklog = useCanManageBacklog(projectId ?? undefined);
  const { data: program } = useProgram(programId ?? undefined);

  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function canCreate(kind: CreateTargetKind): boolean {
    switch (kind) {
      case 'task':
      case 'milestone':
        return role !== null && canEditTask(role);
      case 'story':
        return canBacklog;
      case 'project':
        // Program admin+ may add a project to the program (ADR-0130 §C).
        return program?.my_role != null && program.my_role >= ROLE_ADMIN;
      default:
        return false;
    }
  }

  function intentFor(kind: CreateTargetKind): CreateIntent | null {
    switch (kind) {
      case 'task':
        return projectId ? { kind: 'task', projectId } : null;
      case 'milestone':
        return projectId ? { kind: 'task', projectId, isMilestone: true } : null;
      case 'story':
        return projectId ? { kind: 'story', projectId } : null;
      case 'project':
        return { kind: 'project', programId: programId ?? undefined };
      default:
        return null;
    }
  }

  function dispatch(kind: CreateTargetKind) {
    const intent = intentFor(kind);
    if (intent) open(intent);
    setMenuOpen(false);
  }

  const visible = resolveCreateTargets(pathname).filter((t) => canCreate(t.kind));
  if (visible.length === 0) return null;

  // Single target → a plain button ("New task"). >1 → a menu (Schedule: Task/Milestone).
  if (visible.length === 1) {
    const t = visible[0];
    return (
      <button type="button" onClick={() => dispatch(t.kind)} className={TRIGGER} aria-label={`New ${t.label}`}>
        <PlusIcon aria-hidden="true" />
        <span>New {t.label}</span>
      </button>
    );
  }

  return (
    <div ref={wrapperRef} className="relative hidden md:block shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Create new"
        className={TRIGGER}
      >
        <PlusIcon aria-hidden="true" />
        <span>New</span>
        <span aria-hidden="true">▾</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          aria-label="Create new"
          className="absolute top-full right-0 mt-1 z-50 min-w-[160px] bg-neutral-surface border border-neutral-border rounded p-1"
        >
          {visible.map((t: CreateTarget) => (
            <button
              key={t.kind}
              role="menuitem"
              type="button"
              onClick={() => dispatch(t.kind)}
              className="w-full text-left px-2 py-1.5 rounded text-sm capitalize text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
