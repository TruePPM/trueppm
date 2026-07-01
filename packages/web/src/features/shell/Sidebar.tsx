import { useMemo, useState, useEffect, useCallback } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useMyWork } from '@/hooks/useMyWork';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useEdition } from '@/hooks/useEdition';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { toast } from '@/components/Toast';
import { modifierKeyLabel } from '@/lib/platform';
import { LogoMark, SearchIcon, ChevronRightIcon, PlusIcon, SettingsIcon } from '@/components/Icons';
import { NewProjectModal } from './NewProjectModal';
import { NewProgramModal } from '@/features/programs/NewProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';

interface Props {
  isDrawer?: boolean;
  onClose?: () => void;
}

type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

const HEALTH_LABEL: Record<HealthState, string> = {
  'on-track': 'on track',
  'at-risk': 'at risk',
  critical: 'critical',
  unknown: 'health unknown',
};

/** 8px health CIRCLE (rule 158: circle = health, never the program identity
 *  square). Known states fill the semantic color; unknown is a hollow ring.
 *  aria-hidden — the row's aria-label carries the health word (rule 6). */
function HealthDot({ state }: { state: HealthState }) {
  if (state === 'unknown') {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-neutral-text-disabled"
      />
    );
  }
  const cls =
    state === 'on-track'
      ? 'bg-semantic-on-track'
      : state === 'at-risk'
        ? 'bg-semantic-at-risk'
        : 'bg-semantic-critical';
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

// Section-header typography (rule 36). Split out so the Programs header can
// reuse the type tokens on its <h2> while the inner NavLink owns the padding,
// touch target, and active/hover state.
const GROUP_LABEL_TEXT = 'text-xs font-semibold uppercase tracking-widest';
const GROUP_LABEL = `px-3 pt-3 pb-1 ${GROUP_LABEL_TEXT} text-chrome-text-secondary`;

// Active vs idle nav row (rule 37: 2px left border + sage tint fill).
function rowClass(active: boolean): string {
  return [
    'group flex items-center gap-2 w-full pl-2.5 pr-2 py-2 rounded-control text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
    active
      ? 'bg-brand-primary/10 border-l-2 border-brand-primary text-chrome-text-primary font-medium'
      : 'border-l-2 border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
  ].join(' ');
}

/**
 * The v2 left rail (ADR-0126, handoff 01-shell-and-ia.md) — 248px, top→bottom:
 * brand + collapse, ⌘K trigger, Personal (My Work / Inbox), Shortcuts (pinned
 * projects), Organization (Portfolio rollup — Enterprise-gated, absent in OSS),
 * Programs (expandable tree), and the user footer + settings gear. Replaces the
 * #959 scope-picker sidebar.
 *
 * Kept the export name `Sidebar` + the isDrawer/onClose props so AppShell and the
 * mobile drawer are unchanged. On desktop the rail is expanded (248px) or fully
 * hidden (0px, `inert` + aria-hidden — ADR-0127); the context bar's ≡ re-opens it.
 */
export function Sidebar({ isDrawer = false, onClose }: Props) {
  const navigate = useNavigate();
  const { sidebarCollapsed, sidebarUserControlled, toggleSidebar, setSidebarCollapsed } =
    useShellStore();
  const sidebarWidth = useShellStore(selectSidebarWidth);
  const pinned = useShellStore((s) => s.pinnedProjectIds);
  const togglePin = useShellStore((s) => s.togglePin);
  const expanded = useShellStore((s) => s.expandedProgramIds);
  const toggleProgram = useShellStore((s) => s.toggleProgram);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);

  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  const { data: myWorkData } = useMyWork();
  const dueTodayCount = myWorkData?.pages[0]?.due_today_count ?? 0;
  const { user } = useCurrentUser();
  const { edition } = useEdition();

  const canAccessAdminSettings = user?.can_access_admin_settings ?? true;
  const settingsTo = canAccessAdminSettings ? '/settings' : '/me/settings/notifications';
  const settingsLabel = canAccessAdminSettings ? 'Workspace settings' : 'Notification settings';

  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // The drawer is always expanded. On desktop the rail is either expanded (248px)
  // or fully hidden (0px, "hide-to-context-bar" per ADR-0127) — there is no icon
  // rail. When hidden the rail is `inert` so its content leaves the tab order and
  // the a11y tree; the re-open ≡ lives in the unified shell bar.
  const showFull = !sidebarCollapsed || isDrawer;
  const hidden = sidebarCollapsed && !isDrawer;

  const projectById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof projects>[number]>();
    for (const p of projects ?? []) m.set(p.id, p);
    return m;
  }, [projects]);

  const pinnedProjects = useMemo(
    () => pinned.map((id) => projectById.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
    [pinned, projectById],
  );
  const orphanProjects = useMemo(() => (projects ?? []).filter((p) => !p.programId), [projects]);
  const countFor = useCallback(
    (programId: string) => (projects ?? []).filter((p) => p.programId === programId).length,
    [projects],
  );

  // Auto-collapse < lg unless the user took control (preserved from the prior sidebar).
  const handleResize = useCallback(() => {
    if (sidebarUserControlled) return;
    setSidebarCollapsed(window.matchMedia('(max-width: 1023px)').matches, false);
  }, [sidebarUserControlled, setSidebarCollapsed]);
  useEffect(() => {
    if (isDrawer) return;
    handleResize();
    const mq = window.matchMedia('(max-width: 1023px)');
    mq.addEventListener('change', handleResize);
    return () => mq.removeEventListener('change', handleResize);
  }, [isDrawer, handleResize]);

  // Drawer: Esc closes.
  useEffect(() => {
    if (!isDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isDrawer, onClose]);

  const go = (to: string) => {
    void navigate(to);
    if (isDrawer) onClose?.();
  };

  return (
    <>
      <aside
        id="primary-nav-rail"
        aria-label="Primary navigation"
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        style={isDrawer ? undefined : { width: sidebarWidth, transition: 'width 200ms ease-out' }}
        className={[
          'flex flex-col h-full bg-chrome-surface overflow-hidden flex-shrink-0',
          'border-r border-chrome-border/8',
          isDrawer ? 'w-[248px]' : '',
        ].join(' ')}
      >
        {/* Brand + collapse (≡ in the unified shell bar re-opens when hidden) */}
        <div className="flex items-center gap-2 px-3 h-12 shrink-0 border-b border-chrome-border/8">
          <NavLink to="/me/work" aria-label="TruePPM — My Work" className="flex items-center gap-2 min-w-0">
            <LogoMark size={22} className="shrink-0" />
            <span className="font-display text-base font-bold tracking-[-0.02em] leading-none truncate">
              <span className="text-navy-700 dark:text-reversed">True</span>
              <span className="text-sage-500">PPM</span>
            </span>
          </NavLink>
          <div className="flex-1" />
          {!isDrawer && (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              title={`Hide sidebar (${modifierKeyLabel()}B)`}
              className="w-9 h-9 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
            >
              <span aria-hidden="true" className="text-base leading-none">«</span>
            </button>
          )}
        </div>

        {/* ⌘K trigger */}
        {showFull && (
          <div className="px-2 pt-2 shrink-0">
            <button
              type="button"
              onClick={() => openPalette(true)}
              aria-label="Search or jump to (command palette)"
              aria-keyshortcuts="Meta+K Control+K"
              className="flex w-full items-center gap-2 h-8 rounded-control border border-chrome-border/15 bg-chrome-surface-raised px-2.5 text-chrome-text-secondary hover:text-chrome-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
            >
              <SearchIcon className="h-4 w-4 shrink-0" />
              <span className="text-[13px]">Search or jump to…</span>
              <kbd className="tppm-mono ml-auto shrink-0 rounded-chip border border-chrome-border/20 px-1.5 py-0.5 text-[11px]">
                {modifierKeyLabel()}K
              </kbd>
            </button>
          </div>
        )}

        {/* Scrollable nav */}
        <nav aria-label="Workspace navigation" className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
          {/* Personal */}
          {showFull && <h2 className={GROUP_LABEL}>Personal</h2>}
          <NavLink
            to="/me/work"
            aria-label={dueTodayCount > 0 ? `My Work, ${dueTodayCount} due today` : 'My Work'}
            onClick={() => isDrawer && onClose?.()}
            className={({ isActive }) => rowClass(isActive)}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
              <path d="M2 3h10v2H2V3zm0 3h10v2H2V6zm0 3h6v2H2V9z" />
            </svg>
            {showFull && <span className="min-w-0 truncate">My Work</span>}
            {showFull && dueTodayCount > 0 && (
              <span className="tppm-mono ml-auto shrink-0 rounded-full bg-semantic-critical-bg px-1.5 py-0.5 text-xs text-semantic-critical">
                {dueTodayCount}
              </span>
            )}
          </NavLink>
          <NavLink
            to="/me/notifications"
            aria-label="Inbox"
            onClick={() => isDrawer && onClose?.()}
            className={({ isActive }) => rowClass(isActive)}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
              <path d="M7 1a3 3 0 0 0-3 3v2.5L2.5 9h9L10 6.5V4a3 3 0 0 0-3-3Zm0 12a2 2 0 0 0 2-2H5a2 2 0 0 0 2 2Z" />
            </svg>
            {showFull && <span className="min-w-0 truncate">Inbox</span>}
          </NavLink>

          {/* Shortcuts (pinned) */}
          {showFull && pinnedProjects.length > 0 && (
            <>
              <h2 className={GROUP_LABEL}>Shortcuts</h2>
              {pinnedProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  name={p.name}
                  health={(p.healthState as HealthState) ?? 'unknown'}
                  openTaskCount={p.openTaskCount}
                  pinned
                  onOpen={() => go(`/projects/${p.id}/overview`)}
                  onTogglePin={() => togglePin(p.id)}
                />
              ))}
            </>
          )}

          {/* Organization — org-level destinations. Resources catalog is OSS and
              always present (its icon persists in the collapsed rail, parity with
              My Work / Inbox); Portfolio rollup is cross-program (Enterprise,
              post-1.0): under the enterprise edition it routes to the real
              slot-registered view, under community it is a disabled, grayed-out
              row with a tooltip (rule 177) rather than vanishing (rule 15) or
              being promoted before it ships. The group heading + Portfolio are
              expanded-only. */}
          {showFull && <h2 className={GROUP_LABEL}>Organization</h2>}
          <NavLink
            to="/resources"
            aria-label="Resources catalog"
            onClick={() => isDrawer && onClose?.()}
            className={({ isActive }) => rowClass(isActive)}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
              <path d="M5 3.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM0 11c0-1.7 1.3-3 3-3s3 1.3 3 3v1H0v-1Zm8 0c0-1.7 1.3-3 3-3s3 1.3 3 3v1H8v-1Z" />
            </svg>
            {showFull && <span className="min-w-0 truncate">Resources</span>}
          </NavLink>
          {showFull && edition === 'enterprise' && (
            <NavLink
              to="/portfolio"
              onClick={() => isDrawer && onClose?.()}
              className={({ isActive }) => rowClass(isActive)}
            >
              <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
              </svg>
              <span className="min-w-0 truncate">Portfolio rollup</span>
            </NavLink>
          )}
          {/* Community edition: the cross-program Portfolio rollup is Enterprise
              and not purchasable until post-1.0, so it is neither hidden (which
              reads as broken OSS) nor promoted (a prominent badge/marketing page
              for a feature you can't buy yet is premature). It renders as a
              disabled, grayed-out row with a tooltip — the rule-122 / HeatmapPage
              "Level loads" pattern (rule 177). Promote to the rule-121 EE-badge
              upsell once the feature ships at 1.0. */}
          {showFull && edition === 'community' && (
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Portfolio rollup — available in TruePPM Enterprise (post-1.0)"
              title="Available in TruePPM Enterprise (post-1.0)"
              className="group flex w-full items-center gap-2 rounded-control border-l-2 border-transparent py-2 pl-2.5 pr-2 text-sm text-chrome-text-secondary opacity-50 cursor-not-allowed"
            >
              <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
              </svg>
              <span className="min-w-0 truncate">Portfolio rollup</span>
            </button>
          )}

          {/* Programs — the group header is a NavLink to the /programs gateway,
              not a dead <h2> label like Personal/Organization: /programs is a
              real index page, and it is the only in-app route to the "Load demo
              data" on-ramp that lives on it. The <h2> stays for heading
              semantics (rule 36); the inner link carries the rule-5 44px touch
              target and rule-4 focus ring. Below is the expandable per-program
              tree. */}
          {showFull && (
            <div className="flex items-center justify-between pr-1">
              <h2 className={`flex-1 ${GROUP_LABEL_TEXT}`}>
                <NavLink
                  to="/programs"
                  onClick={() => isDrawer && onClose?.()}
                  className={({ isActive }) =>
                    [
                      'group/programs flex min-h-11 items-center gap-1 rounded-control px-3 pt-3 pb-1',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                      isActive
                        ? 'text-chrome-text-primary'
                        : 'text-chrome-text-secondary hover:text-chrome-text-primary',
                    ].join(' ')
                  }
                >
                  <span className="group-hover/programs:underline">Programs</span>
                  <ChevronRightIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
                </NavLink>
              </h2>
              <button
                type="button"
                onClick={() => setShowNewProgram(true)}
                aria-label="New program"
                className="w-8 h-8 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
              >
                <PlusIcon className="h-3 w-3" />
              </button>
            </div>
          )}
          {showFull &&
            (programs ?? []).map((prog) => {
              const isExpanded = expanded.includes(prog.id);
              const kids = (projects ?? []).filter((p) => p.programId === prog.id);
              return (
                <div key={prog.id}>
                  <div className={rowClass(false)}>
                    <button
                      type="button"
                      onClick={() => toggleProgram(prog.id)}
                      aria-label={isExpanded ? `Collapse ${prog.name}` : `Expand ${prog.name}`}
                      aria-expanded={isExpanded}
                      className="shrink-0 -ml-0.5 flex h-5 w-5 items-center justify-center rounded-control text-chrome-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                    >
                      <ChevronRightIcon
                        className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                    {/* Program identity is a SQUARE (rule 158) — this is a
                        cross-program list, so each row carries the accent square.
                        The xs-label variant labels unset-color programs with their
                        initials so uncolored programs stay distinguishable in this
                        dense scope-picker list (issue 1051). */}
                    <ProgramIdentitySquare program={prog} size="xs-label" />
                    <button
                      type="button"
                      onClick={() => go(`/programs/${prog.id}/overview`)}
                      className="min-w-0 flex-1 truncate text-left focus-visible:outline-none"
                    >
                      {prog.name}
                    </button>
                    <span className="tppm-mono shrink-0 text-xs text-chrome-text-secondary">
                      {countFor(prog.id)}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="ml-3 border-l border-chrome-border/15 pl-1">
                      {kids.length === 0 ? (
                        <p className="px-3 py-1.5 text-xs italic text-chrome-text-secondary">No projects</p>
                      ) : (
                        kids.map((p) => (
                          <ProjectRow
                            key={p.id}
                            name={p.name}
                            health={(p.healthState as HealthState) ?? 'unknown'}
                            openTaskCount={p.openTaskCount}
                            pinned={pinned.includes(p.id)}
                            onOpen={() => go(`/projects/${p.id}/overview`)}
                            onTogglePin={() => togglePin(p.id)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}

          {/* Standalone projects (no program) */}
          {showFull && orphanProjects.length > 0 && (
            <>
              <h2 className={GROUP_LABEL}>Projects</h2>
              {orphanProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  name={p.name}
                  health={(p.healthState as HealthState) ?? 'unknown'}
                  openTaskCount={p.openTaskCount}
                  pinned={pinned.includes(p.id)}
                  onOpen={() => go(`/projects/${p.id}/overview`)}
                  onTogglePin={() => togglePin(p.id)}
                />
              ))}
            </>
          )}

          {/* New project (kept from the prior sidebar's affordances) */}
          {showFull && (
            <div className="flex items-center gap-1 px-1 pt-2">
              <button
                type="button"
                onClick={() => setShowNewProject(true)}
                className="flex-1 rounded-control border border-chrome-border/15 px-2 py-1.5 text-xs text-chrome-text-secondary hover:text-chrome-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
              >
                + New project
              </button>
              <button
                type="button"
                onClick={() => setShowImport(true)}
                aria-label="Import a project from a file"
                title="Import a project from a file"
                className="w-8 h-8 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 8V1m0 0L3.5 3.5M6 1l2.5 2.5M2 8.5v1A1.5 1.5 0 003.5 11h5A1.5 1.5 0 0010 9.5v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )}
        </nav>

        {/* Footer — user + settings */}
        <div className="shrink-0 border-t border-chrome-border/8 p-2">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/15 text-xs font-semibold text-brand-primary"
            >
              {user?.initials ?? '··'}
            </span>
            {showFull && (
              <span className="min-w-0 truncate text-sm text-chrome-text-primary">
                {user?.display_name ?? user?.username ?? 'Account'}
              </span>
            )}
            <div className="flex-1" />
            <NavLink
              to={settingsTo}
              aria-label={settingsLabel}
              onClick={() => isDrawer && onClose?.()}
              className={({ isActive }) =>
                [
                  'w-9 h-9 flex items-center justify-center rounded-control transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                  isActive
                    ? 'bg-brand-primary/10 text-chrome-text-primary'
                    : 'text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
                ].join(' ')
              }
            >
              <SettingsIcon className="h-4 w-4" />
            </NavLink>
          </div>
        </div>
      </aside>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(projectId) => {
            setShowNewProject(false);
            if (isDrawer) onClose?.();
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
      {showNewProgram && (
        <NewProgramModal
          onClose={() => setShowNewProgram(false)}
          onCreated={(programId) => {
            setShowNewProgram(false);
            if (isDrawer) onClose?.();
            void navigate(`/programs/${programId}/projects`);
          }}
        />
      )}
      {showImport && (
        <ImportProjectModal
          onClose={() => setShowImport(false)}
          onCreated={(projectId) => {
            setShowImport(false);
            if (isDrawer) onClose?.();
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
    </>
  );
}

/** One project row — health dot + name (opens overview) + open-task count + a ★ pin toggle. */
function ProjectRow({
  name,
  health,
  openTaskCount,
  pinned,
  onOpen,
  onTogglePin,
}: {
  name: string;
  health: HealthState;
  openTaskCount: number | null;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  return (
    <div className={rowClass(false)}>
      <HealthDot state={health} />
      <button
        type="button"
        onClick={onOpen}
        aria-label={
          openTaskCount != null
            ? `${name}, ${HEALTH_LABEL[health]}, ${openTaskCount} open ${openTaskCount === 1 ? 'task' : 'tasks'}`
            : `${name}, ${HEALTH_LABEL[health]}`
        }
        className="min-w-0 flex-1 truncate text-left focus-visible:outline-none"
      >
        {name}
      </button>
      {/* Right-aligned open-task count (rule 7: mono numerals). aria-hidden —
          the count is already in the name button's aria-label above. The pin
          toggle reveals on hover and overlays this when present. */}
      {openTaskCount != null && openTaskCount > 0 && (
        <span
          aria-hidden="true"
          className="tppm-mono shrink-0 text-xs text-chrome-text-secondary group-hover:hidden"
        >
          {openTaskCount}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          onTogglePin();
          // `pinned` is the pre-toggle state, so the message reflects the result.
          toast.info(pinned ? `Removed ${name} from Shortcuts` : `Pinned ${name} to Shortcuts`);
        }}
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name} to Shortcuts`}
        aria-pressed={pinned}
        title={pinned ? 'Unpin' : 'Pin to Shortcuts'}
        className="shrink-0 rounded-control p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
          className={pinned ? 'text-semantic-at-risk' : 'text-chrome-text-secondary'}
        >
          <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.3l.7-4.3-3.1-3 4.3-.6L8 1.5z" />
        </svg>
      </button>
    </div>
  );
}
