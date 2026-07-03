import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { SprintIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentSprintTargets } from '@/hooks/useCurrentSprintTargets';

const TRIGGER =
  'hidden md:inline-flex shrink-0 items-center gap-1 h-8 px-2.5 rounded-control border border-chrome-border/15 text-sm font-medium text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface';

/**
 * Pinned "Current sprint" shell affordance (issue 1594) — one click lands the user on
 * today's active sprint board, so a Scrum Master running 2–3 teams never hunts
 * through the SPRINT view tabs to reach it. Complements the ⌘K "Current sprint"
 * action, which it shares its targets with via `useCurrentSprintTargets`
 * (web-rule 214 — mirror chrome derives state from one source).
 *
 * Renders adaptively to how many active sprints the user has:
 *  - 0 targets → nothing (no dead chrome). This is also the WATERFALL / no-active-
 *    sprint state; the gate lives in the shared hook.
 *  - 1 target → a plain button that navigates straight to that sprint board.
 *  - >1 (multi-team) → a `role="menu"` popover listing each team's active sprint.
 *
 * Desktop-only (`hidden md:…`, matching the other right-cluster affordances); on
 * mobile the sprint board is reached through the bottom nav.
 */
export function CurrentSprintButton() {
  const navigate = useNavigate();
  const projectId = useProjectId();
  const targets = useCurrentSprintTargets(projectId);

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

  if (targets.length === 0) return null;

  // Single active sprint → a direct button (no menu ceremony for one destination).
  if (targets.length === 1) {
    const t = targets[0];
    return (
      <button
        type="button"
        onClick={() => void navigate(t.path)}
        className={TRIGGER}
        aria-label={`Go to current sprint: ${t.sprintName}`}
        title={`Current sprint — ${t.sprintName}`}
      >
        <SprintIcon className="h-4 w-4" aria-hidden="true" />
        <span>Current sprint</span>
      </button>
    );
  }

  // Multiple teams' sprints → a small menu so the user picks which board to open.
  return (
    <div ref={wrapperRef} className="relative hidden md:block shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Go to current sprint"
        className={TRIGGER}
      >
        <SprintIcon className="h-4 w-4" aria-hidden="true" />
        <span>Current sprint</span>
        <span aria-hidden="true">▾</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          aria-label="Current sprints"
          className="absolute top-full right-0 z-50 mt-1 min-w-[220px] rounded-card border border-neutral-border bg-neutral-surface p-1"
        >
          {targets.map((t) => (
            <button
              key={t.sprintId}
              role="menuitem"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void navigate(t.path);
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-control px-2 py-1.5 text-left text-sm text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
            >
              <span className="w-full truncate">{t.sprintName}</span>
              <span className="tppm-mono w-full truncate text-xs text-neutral-text-secondary">
                {t.projectName}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
