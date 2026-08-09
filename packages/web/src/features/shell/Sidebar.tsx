import {
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
  type ComponentType,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react';
import { NavLink, useNavigate, type NavigateFunction } from 'react-router';

import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useLoadSampleProgram } from '@/hooks/useProgramSeedIo';
import { useMyWork } from '@/hooks/useMyWork';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { useProject } from '@/hooks/useProject';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { usePinned } from '@/hooks/usePins';
import type { PinnedItem } from '@/api/types';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { toast } from '@/components/Toast';
import { PinToggle } from '@/components/PinToggle';
import { AvatarInitials } from '@/components/AvatarInitials';
import { modifierKeyLabel } from '@/lib/platform';
import { initialsForUser, labelForUser } from '@/lib/userIdentity';
import { registry } from '@/lib/widget-registry';
import {
  LogoMark,
  SearchIcon,
  ChevronRightIcon,
  PlusIcon,
  SettingsIcon,
  OverviewIcon,
  ListIcon,
  TagIcon,
  WbsIcon,
  GanttIcon,
  ResourcesIcon,
  BarChartIcon,
  InboxIcon,
  AgentIcon,
} from '@/components/Icons';
import { NewProjectModal } from './NewProjectModal';
import { createdProjectDestination } from './createdProjectDestination';
import { NewProgramModal } from '@/features/programs/NewProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { methodologyStatusLabel } from '@/lib/methodologyLabel';
import { ViewsMenu } from './ViewsMenu';
import type { ProjectHealth } from '@/api/types';

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

// Map the project-detail health enum → the rail's dot state. AUTO ("defer to
// rollup") and any unknown value stay hollow, matching the project-list mapping.
const PROJECT_HEALTH_STATE: Record<ProjectHealth, HealthState> = {
  AUTO: 'unknown',
  ON_TRACK: 'on-track',
  AT_RISK: 'at-risk',
  CRITICAL: 'critical',
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
    'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
    active
      ? 'bg-brand-primary/10 border-l-2 border-brand-primary text-chrome-text-primary font-medium'
      : 'border-l-2 border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
  ].join(' ');
}

// The fixed program view surface (ADR-0095) — the SAME set and order the removed
// TopBar `ProgramTabs` strip carried, relocated here as the rail's "This program"
// tier (#1920). No methodology/role gating: the program tab set is short and
// fixed, and each page gates its own writes (like the project Settings tab).
const PROGRAM_VIEWS: {
  view: string;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;
}[] = [
  { view: 'overview', label: 'Overview', Icon: OverviewIcon },
  { view: 'backlog', label: 'Backlog', Icon: ListIcon },
  { view: 'labels', label: 'Labels', Icon: TagIcon },
  { view: 'projects', label: 'Projects', Icon: WbsIcon },
  { view: 'schedule', label: 'Schedule', Icon: GanttIcon },
  { view: 'resources', label: 'Resources', Icon: BarChartIcon },
  // Governance-of-execution sits next to capacity-of-execution (#2020, ADR-0362):
  // the OSS per-program read of what the team's own agents did.
  { view: 'agents', label: 'Agents', Icon: AgentIcon },
  { view: 'members', label: 'Members', Icon: ResourcesIcon },
  // Unified Assets surface — files + external links across the program's
  // readable member projects (ADR-0215, issue 971).
  { view: 'assets', label: 'Assets', Icon: InboxIcon },
  { view: 'settings', label: 'Settings', Icon: SettingsIcon },
];

// The "You" card's personal rows use a raised active treatment instead of the
// rule-37 sage tint: the active row reads as a lifted neutral surface via a
// BORDER, never a shadow (rule 1). Idle rows match `rowClass` so the card and
// the rest of the rail stay visually coherent.
function youRowClass(active: boolean): string {
  return [
    'group flex items-center gap-2 w-full px-2 py-2 rounded-control text-sm transition-colors',
    'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
    active
      ? 'bg-neutral-surface border border-neutral-border text-chrome-text-primary font-medium'
      : 'border border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
  ].join(' ');
}

// Auto-collapse the desktop rail below `lg` unless the user took manual control
// (preserved from the prior sidebar). Isolated from the component so the rail body
// stays a thin orchestrator (issue 2369).
function useAutoCollapseSidebar(
  isDrawer: boolean,
  sidebarUserControlled: boolean,
  setSidebarCollapsed: (collapsed: boolean, userControlled?: boolean) => void,
) {
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
}

// Drawer variant: Esc closes it.
function useDrawerEscape(isDrawer: boolean, onClose?: () => void) {
  useEffect(() => {
    if (!isDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isDrawer, onClose]);
}

// Desktop "Browse" switcher: Esc closes + returns focus to the trigger, and an
// outside click closes it. On open, focus moves into the panel (rule: a
// disclosure that opens a focus context re-seats focus).
function useBrowseSwitcherDismiss(
  switchOpen: boolean,
  setSwitchOpen: (open: boolean) => void,
  switchTriggerRef: RefObject<HTMLButtonElement | null>,
  switchPanelRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!switchOpen) return;
    const closeToTrigger = () => {
      setSwitchOpen(false);
      switchTriggerRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeToTrigger();
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !switchPanelRef.current?.contains(target) &&
        !switchTriggerRef.current?.contains(target)
      ) {
        setSwitchOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    switchPanelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [switchOpen, setSwitchOpen, switchTriggerRef, switchPanelRef]);
}

/**
 * The v2 left rail (ADR-0126) restructured into three role-scoped tiers (issue 1642):
 *
 *   1. **You** — a framed card: identity + the personal destinations (My Work,
 *      Timesheet, Notifications) that used to live in the flat "Personal" group.
 *   2. **This project** — the active project's methodology-adaptive grouped views,
 *      rendered from the SAME composition the TopBar `ViewTabs` uses
 *      (`useGroupedProjectViews`) so the two can never drift; off a project this
 *      tier collapses to the pinned-projects list (never a blank band).
 *   3. **Jump** — the ⌘K trigger plus a "Browse projects and programs" switcher
 *      that hosts the relocated Organization / Programs tree / standalone Projects.
 *
 * Kept the export name `Sidebar` + the isDrawer/onClose props so AppShell and the
 * mobile drawer are unchanged. On desktop the rail is expanded (248px) or fully
 * hidden (0px, `inert` + aria-hidden — ADR-0127); the shell bar's ≡ re-opens it.
 * In the drawer every tier is expanded and row clicks call `onClose()`.
 */
export function Sidebar({ isDrawer = false, onClose }: Props) {
  const navigate = useNavigate();
  const { sidebarCollapsed, sidebarUserControlled, toggleSidebar, setSidebarCollapsed } =
    useShellStore();
  const sidebarWidth = useShellStore(selectSidebarWidth);
  const expanded = useShellStore((s) => s.expandedProgramIds);
  const toggleProgram = useShellStore((s) => s.toggleProgram);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);

  const { data: projects, count: projectsCount } = useProjects();
  const { data: programs } = usePrograms();
  const { data: myWorkData } = useMyWork();
  const dueTodayCount = myWorkData?.pages[0]?.due_today_count ?? 0;
  const { user } = useCurrentUser();
  const projectId = useProjectId();
  // Project-scoped role for the "You" card's identity line (#1919). Same
  // `role_label` source the settings team/member rows render — off a project
  // the hook resolves to null and the line is simply omitted, matching Tier 2
  // collapsing to the pinned list rather than showing a stale/blank role.
  const { roleLabel } = useCurrentUserRole(projectId);
  const { count: unreadCount } = useUnreadNotificationCount();
  // Program context is detected the same way project context is: `useProgramId`
  // reads the `:programId` path param, so it is defined only on `/programs/:id/*`
  // routes (undefined on project and global routes). A URL is either
  // `/projects/:id/*` or `/programs/:id/*`, never both, so `projectId` and
  // `programId` are mutually exclusive — Tier 2 renders the project views, the
  // program views, or (off both) the pinned list. Detecting program context here
  // is what lets the rail become the sole nav home for program views after
  // `ProgramTabs` left the TopBar (#1920).
  const programId = useProgramId();

  // The gear under the signed-in identity is the always-visible Settings entry
  // in the primary chrome (#2298). It is ROLE-AWARE: a workspace admin lands on
  // the workspace `/settings` hub they configure daily; everyone else lands on
  // their *personal* settings (#1793). This keeps the earlier no-dead-end
  // guarantee (#1738/#2033: a non-admin never gets bounced by
  // `RequireAdminSettings`) while giving admins a persistent one-click route to
  // workspace settings instead of hiding it inside the avatar menu. `=== true`
  // so a loading/absent role signal defaults to the safe personal destination
  // rather than flashing an admin route a member can't use. The tooltip names the
  // destination so the icon is never ambiguous about where it goes.
  const isWorkspaceAdmin = useIsWorkspaceAdmin() === true;
  const settingsTo = isWorkspaceAdmin ? '/settings' : '/me/settings/general';
  const settingsLabel = isWorkspaceAdmin ? 'Workspace settings' : 'Personal settings';

  const [showNewProject, setShowNewProject] = useState(false);
  // Which of NewProjectModal's two create actions is primary (#2710). Set by
  // whichever affordance opened it, so a user who clicked "Import a spreadsheet"
  // is not then asked to pick the modal's secondary button.
  const [newProjectImportFirst, setNewProjectImportFirst] = useState(false);
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Tier 3 "Browse" switcher disclosure (desktop only; the drawer renders the
  // same content inline, always expanded).
  const [switchOpen, setSwitchOpen] = useState(false);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switchPanelRef = useRef<HTMLDivElement>(null);

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

  const programById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof programs>[number]>();
    for (const prog of programs ?? []) m.set(prog.id, prog);
    return m;
  }, [programs]);

  // Pins come from the server as their own list (#2390, ADR-0627) rather than
  // being resolved by looking ids up in the loaded project/program lists. That
  // lookup was silently lossy: a pinned project past the list page ceiling
  // resolved to `undefined` and vanished from the rail with no indication that
  // anything was missing. `/auth/me/pinned/` returns the display fields inline,
  // so a pinned item renders whether or not it is on the current page.
  const { data: pinnedItems, isLoading: pinsLoading, isError: pinsError } = usePinned();
  const pinnedProgramList = useMemo(
    () => (pinnedItems ?? []).filter((i) => i.kind === 'program'),
    [pinnedItems],
  );
  // Identity comes from the pins endpoint; health and the open-task count are
  // enrichments from the already-loaded project list. A pinned project beyond
  // the page ceiling still renders — it just shows a hollow 'unknown' dot and no
  // count, which is the honest rendering of "we have the name but not the
  // annotations" and matches how any un-annotated project row already behaves.
  const pinnedProjects = useMemo(
    () =>
      (pinnedItems ?? [])
        .filter((i) => i.kind === 'project')
        .map((i) => {
          const loaded = projectById.get(i.id);
          return {
            id: i.id,
            name: i.name,
            healthState: (loaded?.healthState as HealthState | undefined) ?? 'unknown',
            openTaskCount: loaded?.openTaskCount ?? null,
          };
        }),
    [pinnedItems, projectById],
  );
  const hasPins = pinnedProgramList.length > 0 || pinnedProjects.length > 0;
  const orphanProjects = useMemo(() => (projects ?? []).filter((p) => !p.programId), [projects]);
  const countFor = useCallback(
    (programId: string) => (projects ?? []).filter((p) => p.programId === programId).length,
    [projects],
  );

  // Rail lifecycle effects (auto-collapse, drawer Esc, Browse-switcher dismissal)
  // are isolated in hooks so this component stays a thin orchestrator (issue 2369).
  useAutoCollapseSidebar(isDrawer, sidebarUserControlled, setSidebarCollapsed);
  useDrawerEscape(isDrawer, onClose);
  useBrowseSwitcherDismiss(switchOpen, setSwitchOpen, switchTriggerRef, switchPanelRef);

  // Navigating OUT of the switcher dismisses it: the desktop popover
  // (`switchOpen`) and, in the drawer, the whole drawer (`onClose` is defined
  // only there). Selecting a destination is terminal, so the switcher closes on
  // select like every other menu-class surface. We deliberately do NOT return
  // focus to the trigger here (that is the Escape/cancel behavior) — the route
  // change owns focus on a commit. Program expand/collapse (`toggleProgram`) is
  // disclosure, not navigation, so it never calls this: drilling into a program
  // to find a project keeps the switcher open.
  const dismissSwitcher = () => {
    setSwitchOpen(false);
    onClose?.();
  };
  const go = (to: string) => {
    void navigate(to);
    dismissSwitcher();
  };
  // Zero-project rail fallback (#2034): the "load a demo" action mirrors
  // MyWorkEmptyState — load the bundled sample, then land the user on the board
  // holding their freshly-assigned sprint (falling back to program overview).
  const loadSample = useLoadSampleProgram();
  const loadDemo = () => {
    loadSample.mutate(undefined, {
      onSuccess: (result) => {
        dismissSwitcher();
        onClose?.();
        void navigate(
          result.landing_project_id
            ? `/projects/${result.landing_project_id}/board`
            : `/programs/${result.program.id}/overview`,
          { state: { startExploringSample: result.sample_key } },
        );
      },
      onError: () => toast.error("Couldn't load the demo — please try again."),
    });
  };
  const closeDrawer = () => {
    if (isDrawer) onClose?.();
  };

  // The Organization + Programs tree + standalone Projects — relocated into the
  // Tier-3 switcher. Rendered inline in the drawer and inside the desktop popover.
  // A plain <div> (not a <nav> landmark): the links live inside the rail's
  // complementary landmark already, and a nested nav named with "program" / "view"
  // would strict-mode-collide with the ProgramTabs / ViewTabs nav-name e2e locators.
  const browseContent = (
    <BrowseContent
      programs={programs}
      projects={projects}
      expanded={expanded}
      orphanProjects={orphanProjects}
      projectsCount={projectsCount}
      countFor={countFor}
      go={go}
      dismissSwitcher={dismissSwitcher}
      toggleProgram={toggleProgram}
      openPalette={openPalette}
      setShowNewProgram={setShowNewProgram}
      setShowNewProject={setShowNewProject}
      setShowImport={setShowImport}
    />
  );

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
        <SidebarBrand isDrawer={isDrawer} onToggle={toggleSidebar} />

        {/* Scrollable body. The brand header (above) and settings footer (below)
            stay pinned; this column holds Tier 1–3. On the mobile drawer it scrolls
            as ONE region (`overflow-y-auto`) so the inlined Programs tree in Tier 3
            — which is `shrink-0` and would otherwise overflow the `overflow-hidden`
            aside with no way to reach the lower items (#1688) — is reachable. On
            desktop it is a transparent flex passthrough: Tier 2 owns its own scroll
            and Tier 3 is the fixed bottom bar with its Browse popover. */}
        <div
          className={[
            'flex flex-1 flex-col min-h-0',
            isDrawer ? 'overflow-y-auto overflow-x-hidden' : '',
          ].join(' ')}
        >
          {/* Tier 1 — You: identity + the personal destinations. */}
          {showFull && (
            <YouTier
              user={user}
              roleLabel={roleLabel}
              dueTodayCount={dueTodayCount}
              unreadCount={unreadCount}
              closeDrawer={closeDrawer}
            />
          )}

          {/* Tier 2 — This project (grouped views) or, off a project, the pinned list.
            This is the rail's primary in-context landmark (`Workspace navigation`). */}
          <nav
            aria-label="Workspace navigation"
            className={[
              'px-2 pb-2',
              // Desktop: this tier is the scroll region and grows to fill. In the
              // drawer the wrapper scrolls as one, so Tier 2 is plain in-flow content.
              isDrawer ? '' : 'flex-1 overflow-y-auto overflow-x-hidden',
            ].join(' ')}
          >
            {showFull &&
              (projectId ? (
                <ProjectViewsTier projectId={projectId} isDrawer={isDrawer} onClose={onClose} />
              ) : programId ? (
                <ProgramViewsTier programId={programId} isDrawer={isDrawer} onClose={onClose} />
              ) : (
                <PinnedTier
                  setNewProjectImportFirst={setNewProjectImportFirst}
                  hasPins={hasPins}
                  isLoading={pinsLoading}
                  isError={pinsError}
                  pinnedProgramList={pinnedProgramList}
                  pinnedProjects={pinnedProjects}
                  programById={programById}
                  hasProjects={(projects ?? []).length > 0}
                  loadingDemo={loadSample.isPending}
                  go={go}
                  setShowNewProject={setShowNewProject}
                  loadDemo={loadDemo}
                />
              ))}
          </nav>

          {/* Tier 3 — Jump: ⌘K search + the Browse switcher (drawer inlines it).
            Desktop keeps `shrink-0` (fixed bottom bar); in the drawer it is in-flow
            content inside the scroll wrapper so its inlined browse tree scrolls. */}
          {showFull && (
            <JumpTier
              isDrawer={isDrawer}
              openPalette={openPalette}
              switchOpen={switchOpen}
              setSwitchOpen={setSwitchOpen}
              switchTriggerRef={switchTriggerRef}
              switchPanelRef={switchPanelRef}
              browseContent={browseContent}
            />
          )}
        </div>

        <SidebarFooter
          showFull={showFull}
          user={user}
          settingsTo={settingsTo}
          settingsLabel={settingsLabel}
          closeDrawer={closeDrawer}
        />
      </aside>

      <SidebarModals
        showNewProject={showNewProject}
        newProjectImportFirst={newProjectImportFirst}
        showNewProgram={showNewProgram}
        showImport={showImport}
        isDrawer={isDrawer}
        setShowNewProject={setShowNewProject}
        setShowNewProgram={setShowNewProgram}
        setShowImport={setShowImport}
        navigate={navigate}
        onClose={onClose}
      />
    </>
  );
}

type ProjectListItem = NonNullable<ReturnType<typeof useProjects>['data']>[number];
type ProgramListItem = NonNullable<ReturnType<typeof usePrograms>['data']>[number];
/**
 * A pinned project as the rail renders it: identity from `/auth/me/pinned/`,
 * health and count enriched from the loaded project list when it happens to be
 * there (#2390).
 */
type PinnedProjectRow = {
  id: string;
  name: string;
  healthState: HealthState;
  openTaskCount: number | null;
};
type SidebarUser = Parameters<typeof labelForUser>[0];

/** Brand mark + the desktop collapse control (≡ in the unified shell bar re-opens
 *  when hidden). Extracted so the rail body stays a thin orchestrator (issue 2369). */
function SidebarBrand({ isDrawer, onToggle }: { isDrawer: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 h-12 shrink-0 border-b border-chrome-border/8">
      <NavLink
        to="/me/work"
        aria-label="TruePPM — My Work"
        className="flex items-center gap-2 min-w-0"
      >
        <LogoMark size={22} className="shrink-0" />
        <span className="font-display text-base font-bold tracking-[-0.02em] leading-none truncate">
          <span className="text-navy-700 dark:text-reversed">True</span>
          <span className="text-brand-primary">PPM</span>
        </span>
      </NavLink>
      <div className="flex-1" />
      {!isDrawer && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          title={`Hide sidebar (${modifierKeyLabel()}B)`}
          className="w-9 h-9 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
        >
          <span aria-hidden="true" className="text-base leading-none">
            «
          </span>
        </button>
      )}
    </div>
  );
}

/** Tier 1 "You" — identity + the personal destinations (My Work, Timesheet, My
 *  Assets, Notifications) framed as a card. */
function YouTier({
  user,
  roleLabel,
  dueTodayCount,
  unreadCount,
  closeDrawer,
}: {
  user: SidebarUser;
  roleLabel: string | null | undefined;
  dueTodayCount: number;
  unreadCount: number;
  closeDrawer: () => void;
}) {
  return (
    <div className="m-2 rounded-card border border-chrome-border/15 bg-app-canvas p-2">
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <AvatarInitials initials={initialsForUser(user)} size="md" />
        <div className="min-w-0">
          <span className="block min-w-0 truncate text-sm font-medium text-chrome-text-primary">
            {labelForUser(user)}
          </span>
          {roleLabel && (
            <span className="block min-w-0 truncate text-xs text-chrome-text-secondary">
              {roleLabel}
            </span>
          )}
        </div>
      </div>
      <NavLink
        to="/me/work"
        aria-label={dueTodayCount > 0 ? `My Work, ${dueTodayCount} due today` : 'My Work'}
        onClick={closeDrawer}
        className={({ isActive }) => youRowClass(isActive)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 14 14"
          fill="currentColor"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M2 3h10v2H2V3zm0 3h10v2H2V6zm0 3h6v2H2V9z" />
        </svg>
        <span className="min-w-0 truncate">My Work</span>
        {dueTodayCount > 0 && (
          <span className="tppm-mono ml-auto shrink-0 rounded-full bg-semantic-critical-bg px-1.5 py-0.5 text-xs text-semantic-critical">
            {dueTodayCount}
          </span>
        )}
      </NavLink>
      <NavLink
        to="/me/timesheet"
        aria-label="Timesheet"
        onClick={closeDrawer}
        className={({ isActive }) => youRowClass(isActive)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          aria-hidden="true"
          className="shrink-0"
        >
          <rect x="1.5" y="2" width="11" height="10" rx="1" />
          <path d="M1.5 5h11M5 5v7M9 5v7" />
        </svg>
        <span className="min-w-0 truncate">Timesheet</span>
      </NavLink>
      <NavLink
        to="/me/assets"
        aria-label="My Assets"
        onClick={closeDrawer}
        className={({ isActive }) => youRowClass(isActive)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M12 6.5 6.9 11.6a2.5 2.5 0 0 1-3.5-3.5l5-5a1.6 1.6 0 0 1 2.3 2.3l-5 5a.7.7 0 0 1-1-1L9.5 5" />
        </svg>
        <span className="min-w-0 truncate">My Assets</span>
      </NavLink>
      <NavLink
        to="/me/notifications"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        onClick={closeDrawer}
        className={({ isActive }) => youRowClass(isActive)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 14 14"
          fill="currentColor"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M7 1a3 3 0 0 0-3 3v2.5L2.5 9h9L10 6.5V4a3 3 0 0 0-3-3Zm0 12a2 2 0 0 0 2-2H5a2 2 0 0 0 2 2Z" />
        </svg>
        <span className="min-w-0 truncate">Notifications</span>
        {unreadCount > 0 && (
          <span className="tppm-mono ml-auto shrink-0 rounded-full bg-brand-primary px-1.5 py-0.5 text-xs text-neutral-text-inverse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </NavLink>
    </div>
  );
}

/** Tier 2, off a project/program route: the flat pinned jump list, or the
 *  zero-project first-run CTA, or the "pin something" hint. */
/**
 * What the Pinned group shows before it can show pins.
 *
 * Skeleton rows rather than the "pin something" hint while the request is in
 * flight: telling a user who HAS pins that they have none is worse than a brief
 * neutral placeholder. On failure the rail owns the message — silently
 * rendering "no pins" is exactly the "my pins disappeared" moment this feature
 * exists to avoid.
 */
function PinsPlaceholder({ isLoading }: { isLoading: boolean }) {
  if (isLoading) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-1 px-3 py-2">
        <div className="h-4 w-32 animate-pulse rounded bg-chrome-surface-raised" />
        <div className="h-4 w-24 animate-pulse rounded bg-chrome-surface-raised" />
      </div>
    );
  }
  return (
    <p role="status" className="px-3 py-2 text-xs text-chrome-text-secondary">
      Couldn&rsquo;t load pins.
    </p>
  );
}

function PinnedTier({
  hasPins,
  isLoading,
  isError,
  pinnedProgramList,
  pinnedProjects,
  programById,
  hasProjects,
  loadingDemo,
  go,
  setShowNewProject,
  setNewProjectImportFirst,
  loadDemo,
}: {
  hasPins: boolean;
  isLoading: boolean;
  isError: boolean;
  pinnedProgramList: PinnedItem[];
  pinnedProjects: PinnedProjectRow[];
  programById: Map<string, ProgramListItem>;
  hasProjects: boolean;
  loadingDemo: boolean;
  go: (to: string) => void;
  setShowNewProject: Dispatch<SetStateAction<boolean>>;
  setNewProjectImportFirst: Dispatch<SetStateAction<boolean>>;
  loadDemo: () => void;
}) {
  return (
    <>
      <h2 className={GROUP_LABEL}>Pinned</h2>
      {!hasPins && (isLoading || isError) ? (
        <PinsPlaceholder isLoading={isLoading} />
      ) : hasPins ? (
        <>
          {/* Pinned programs first, then pinned projects — a flat jump
              list, not a tree. Items also keep their normal tree
              position; pinning adds a shortcut, it does not relocate. */}
          {pinnedProgramList.map((prog) => {
            // The identity square needs the full program row for its color and
            // initials. A pinned program past the list page ceiling has no
            // loaded row, so fall back to the pin's own name/code — the square
            // degrades, the jump link does not.
            const loaded = programById.get(prog.id);
            return (
              <div key={prog.id} className={rowClass(false)}>
                <ProgramIdentitySquare
                  program={loaded ?? { name: prog.name, code: prog.code ?? '', color: null }}
                  size="xs-label"
                />
                <button
                  type="button"
                  onClick={() => go(`/programs/${prog.id}/overview`)}
                  className="min-w-0 flex-1 truncate rounded-control text-left focus:outline-none focus:ring-2 focus:ring-brand-primary"
                >
                  {prog.name}
                </button>
                <PinToggle
                  kind="program"
                  id={prog.id}
                  name={prog.name}
                  pinned
                  size="sm"
                  tone="chrome"
                />
              </div>
            );
          })}
          {pinnedProjects.map((p) => (
            <ProjectRow
              key={p.id}
              id={p.id}
              name={p.name}
              health={p.healthState}
              openTaskCount={p.openTaskCount}
              pinned
              onOpen={() => go(`/projects/${p.id}/overview`)}
            />
          ))}
        </>
      ) : !hasProjects ? (
        // A zero-project user cannot act on "pin something" advice
        // (#2034) — give them the two things they actually can do.
        // Keep `role="status"` on the advisory text only, not the
        // actions (a live region should not announce controls).
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          <p role="status" className="text-xs text-chrome-text-secondary">
            No projects yet — create one or load a demo.
          </p>
          <button
            type="button"
            onClick={() => {
              setNewProjectImportFirst(false);
              setShowNewProject(true);
            }}
            className="text-xs font-medium text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary rounded-control"
          >
            + New project
          </button>
          {/* The third thing a zero-project user can actually do (#2710): arrive
              with a spreadsheet. The CSV/Excel wizard used to have a single mount
              site that required an existing project, so this surface could only
              offer "create" and "demo" — an evaluator holding their own plan had
              to build an empty project and go hunting through an overflow menu. */}
          <button
            type="button"
            onClick={() => {
              setNewProjectImportFirst(true);
              setShowNewProject(true);
            }}
            className="text-xs font-medium text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary rounded-control"
          >
            Import from a spreadsheet
          </button>
          <button
            type="button"
            onClick={loadDemo}
            disabled={loadingDemo}
            className="text-xs font-medium text-chrome-text-secondary hover:text-chrome-text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary rounded-control disabled:opacity-50"
          >
            {loadingDemo ? 'Loading demo…' : 'Load a demo'}
          </button>
        </div>
      ) : (
        <p role="status" className="px-3 py-2 text-xs italic text-chrome-text-secondary">
          Pin a project from its Overview, or a program from the Programs list.
        </p>
      )}
    </>
  );
}

/** Tier 3 "Jump" — the ⌘K trigger plus the Browse switcher (a desktop popover; the
 *  drawer inlines `browseContent`). */
function JumpTier({
  isDrawer,
  openPalette,
  switchOpen,
  setSwitchOpen,
  switchTriggerRef,
  switchPanelRef,
  browseContent,
}: {
  isDrawer: boolean;
  openPalette: (open: boolean) => void;
  switchOpen: boolean;
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
  switchTriggerRef: RefObject<HTMLButtonElement | null>;
  switchPanelRef: RefObject<HTMLDivElement | null>;
  browseContent: ReactNode;
}) {
  return (
    <div className={['border-t border-chrome-border/8 p-2', isDrawer ? '' : 'shrink-0'].join(' ')}>
      <button
        type="button"
        onClick={() => openPalette(true)}
        aria-label="Search or jump to (command palette)"
        aria-keyshortcuts="Meta+K Control+K"
        className="flex w-full items-center gap-2 h-8 rounded-control border border-chrome-border/15 bg-chrome-surface-raised px-2.5 text-chrome-text-secondary hover:text-chrome-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="text-[13px]">Search or jump to…</span>
        <kbd className="tppm-mono ml-auto shrink-0 rounded-chip border border-chrome-border/20 px-1.5 py-0.5 text-xs">
          {modifierKeyLabel()}K
        </kbd>
      </button>

      {isDrawer ? (
        browseContent
      ) : (
        <div className="relative mt-2">
          <button
            ref={switchTriggerRef}
            type="button"
            onClick={() => setSwitchOpen((v) => !v)}
            aria-expanded={switchOpen}
            aria-controls="rail-browse-panel"
            className="flex w-full items-center gap-2 h-9 rounded-control border border-chrome-border/15 px-2.5 text-sm text-chrome-text-secondary hover:text-chrome-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 14 14"
              fill="currentColor"
              aria-hidden="true"
              className="shrink-0"
            >
              <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-left">Browse projects and programs</span>
            <ChevronRightIcon
              aria-hidden="true"
              className={`h-3 w-3 shrink-0 transition-transform ${switchOpen ? 'rotate-90' : '-rotate-90'}`}
            />
          </button>
          {switchOpen && (
            <div
              ref={switchPanelRef}
              id="rail-browse-panel"
              tabIndex={-1}
              className="absolute bottom-full left-0 z-40 mb-1 max-h-[60vh] w-full overflow-y-auto rounded-card border border-chrome-border/15 bg-chrome-surface shadow-pop focus:outline-none"
            >
              {browseContent}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Rail footer — a quiet "Signed in / {name}" orientation label (not a control,
 *  #1737) plus the role-aware settings gear. */
function SidebarFooter({
  showFull,
  user,
  settingsTo,
  settingsLabel,
  closeDrawer,
}: {
  showFull: boolean;
  user: SidebarUser;
  settingsTo: string;
  settingsLabel: string;
  closeDrawer: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-chrome-border/8 p-2">
      <div className="flex items-center gap-2">
        {showFull && (
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-widest leading-none text-chrome-text-secondary">
              Signed in
            </div>
            <div className="mt-0.5 truncate text-sm font-medium leading-tight text-chrome-text-primary">
              {labelForUser(user)}
            </div>
          </div>
        )}
        {/* When the rail is collapsed (label suppressed) keep the gear right-aligned. */}
        {!showFull && <div className="flex-1" />}
        <NavLink
          to={settingsTo}
          aria-label={settingsLabel}
          title={settingsLabel}
          onClick={closeDrawer}
          className={({ isActive }) =>
            [
              'w-9 h-9 flex items-center justify-center rounded-control transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
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
  );
}

/** The New project / New program / Import modals, rendered as siblings of the rail
 *  so their overlays escape the `overflow-hidden` aside. */
function SidebarModals({
  showNewProject,
  newProjectImportFirst,
  showNewProgram,
  showImport,
  isDrawer,
  setShowNewProject,
  setShowNewProgram,
  setShowImport,
  navigate,
  onClose,
}: {
  showNewProject: boolean;
  newProjectImportFirst: boolean;
  showNewProgram: boolean;
  showImport: boolean;
  isDrawer: boolean;
  setShowNewProject: Dispatch<SetStateAction<boolean>>;
  setShowNewProgram: Dispatch<SetStateAction<boolean>>;
  setShowImport: Dispatch<SetStateAction<boolean>>;
  navigate: NavigateFunction;
  onClose?: () => void;
}) {
  return (
    <>
      {showNewProject && (
        <NewProjectModal
          importFirst={newProjectImportFirst}
          onClose={() => setShowNewProject(false)}
          onCreated={(projectId, intent) => {
            setShowNewProject(false);
            if (isDrawer) onClose?.();
            // Centralized in `createdProjectDestination` (#2710, #2731, #2734) —
            // see that module for the CSV-import, seeded-schedule and
            // agile-backlog landing rationale.
            void navigate(createdProjectDestination(projectId, intent));
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
          onProgramImported={(programId) => {
            // A native TruePPM seed re-materializes as a whole program
            // (ADR-0222); land on its overview, not a single project.
            setShowImport(false);
            if (isDrawer) onClose?.();
            void navigate(`/programs/${programId}/overview`);
          }}
        />
      )}
    </>
  );
}

/** The Organization + Programs tree + standalone Projects for the Tier-3 Browse
 *  switcher. Rendered inline in the drawer and inside the desktop popover. A plain
 *  <div> (not a <nav> landmark): the links live inside the rail's complementary
 *  landmark already, and a nested nav named with "program" / "view" would
 *  strict-mode-collide with the ProgramTabs / ViewTabs nav-name e2e locators. */
function BrowseContent({
  programs,
  projects,
  expanded,
  orphanProjects,
  projectsCount,
  countFor,
  go,
  dismissSwitcher,
  toggleProgram,
  openPalette,
  setShowNewProgram,
  setShowNewProject,
  setShowImport,
}: {
  programs: ProgramListItem[] | undefined;
  projects: ProjectListItem[] | undefined;
  expanded: string[];
  orphanProjects: ProjectListItem[];
  projectsCount: number | undefined;
  countFor: (programId: string) => number;
  go: (to: string) => void;
  dismissSwitcher: () => void;
  toggleProgram: (id: string) => void;
  openPalette: (open: boolean) => void;
  setShowNewProgram: Dispatch<SetStateAction<boolean>>;
  setShowNewProject: Dispatch<SetStateAction<boolean>>;
  setShowImport: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="px-1 pb-2">
      {/* Organization — org-level destinations. Resources catalog is OSS and
          always present; the cross-program Portfolio rollup is Enterprise: the
          rail is the OSS daily path, so per rule 231 (ADR-0266) the community
          edition renders nothing for it — the cross-program seam is discovered at
          /programs, not via a padlocked rail row. The rollup reaches the rail
          through the nav.portfolio_section slot below; there is no built-in
          NavLink for it (#2609). */}
      <h2 className={GROUP_LABEL}>Organization</h2>
      <NavLink
        to="/resources"
        aria-label="Resources catalog"
        onClick={dismissSwitcher}
        className={({ isActive }) => rowClass(isActive)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 14 14"
          fill="currentColor"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M5 3.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM0 11c0-1.7 1.3-3 3-3s3 1.3 3 3v1H0v-1Zm8 0c0-1.7 1.3-3 3-3s3 1.3 3 3v1H8v-1Z" />
        </svg>
        <span className="min-w-0 truncate">Resources</span>
      </NavLink>
      {/* The cross-program Portfolio rollup is a daily-path nav destination, so
          per rule 231 (ADR-0266) it renders through the `nav.portfolio_section`
          extension-point slot: empty in the community edition (no disabled teaser,
          no padlock — the former rule-178 row), populated by the enterprise
          module. This is the empty-slot pattern of `resources_heatmap.level_loads`
          (issue 1614). */}
      {registry.get('nav.portfolio_section').map(({ id, component: Component }) => (
        <Component key={id} />
      ))}

      {/* Programs — the group header is a NavLink to the /programs gateway (the
          only in-app route to the "Load demo data" on-ramp), not a dead label. */}
      <div className="flex items-center justify-between pr-1">
        <h2 className={`flex-1 ${GROUP_LABEL_TEXT}`}>
          <NavLink
            to="/programs"
            onClick={dismissSwitcher}
            className={({ isActive }) =>
              [
                'group/programs flex min-h-11 items-center gap-1 rounded-control px-3 pt-3 pb-1',
                'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
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
          className="w-8 h-8 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
        >
          <PlusIcon className="h-3 w-3" />
        </button>
      </div>
      {(programs ?? []).map((prog) => {
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
                className="shrink-0 -ml-0.5 flex h-5 w-5 items-center justify-center rounded-control text-chrome-text-secondary focus:outline-none focus:ring-2 focus:ring-brand-primary"
              >
                <ChevronRightIcon
                  className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                />
              </button>
              {/* Program identity is a SQUARE (rule 158). The xs-label variant labels
                  unset-color programs with their initials so uncolored programs stay
                  distinguishable in this dense switcher list (issue 1051). */}
              <ProgramIdentitySquare program={prog} size="xs-label" />
              <button
                type="button"
                onClick={() => go(`/programs/${prog.id}/overview`)}
                className="min-w-0 flex-1 truncate rounded-control text-left focus:outline-none focus:ring-2 focus:ring-brand-primary"
              >
                {prog.name}
              </button>
              {/* Count hides on hover so the pin toggle can overlay this slot. */}
              <span className="tppm-mono shrink-0 text-xs text-chrome-text-secondary md:group-hover:hidden">
                {countFor(prog.id)}
              </span>
              <PinToggle
                kind="program"
                id={prog.id}
                name={prog.name}
                pinned={prog.is_pinned ?? false}
                size="sm"
                tone="chrome"
              />
            </div>
            {isExpanded && (
              <div className="ml-3 border-l border-chrome-border/15 pl-1">
                {kids.length === 0 ? (
                  <p className="px-3 py-1.5 text-xs italic text-chrome-text-secondary">
                    No projects
                  </p>
                ) : (
                  kids.map((p) => (
                    <ProjectRow
                      key={p.id}
                      id={p.id}
                      name={p.name}
                      health={(p.healthState as HealthState) ?? 'unknown'}
                      openTaskCount={p.openTaskCount}
                      pinned={p.isPinned ?? false}
                      onOpen={() => go(`/projects/${p.id}/overview`)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Standalone projects (no program) */}
      {orphanProjects.length > 0 && (
        <>
          <h2 className={GROUP_LABEL}>Projects</h2>
          {orphanProjects.map((p) => (
            <ProjectRow
              key={p.id}
              id={p.id}
              name={p.name}
              health={(p.healthState as HealthState) ?? 'unknown'}
              openTaskCount={p.openTaskCount}
              pinned={p.isPinned ?? false}
              onOpen={() => go(`/projects/${p.id}/overview`)}
            />
          ))}
        </>
      )}

      {/* Overflow cue (ADR-0401/#1940): the project list is fetched at a raised
          page ceiling, but if an account exceeds it the tree would otherwise
          truncate silently. Surface the honest count and point at ⌘K search. */}
      {projectsCount !== undefined && projectsCount > (projects?.length ?? 0) && (
        <button
          type="button"
          onClick={() => openPalette(true)}
          className="mt-1 w-full rounded-control px-3 py-2 text-left text-xs text-chrome-text-secondary hover:text-chrome-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
        >
          Showing {projects?.length ?? 0} of {projectsCount} projects — search in ⌘K
        </button>
      )}

      {/* New project / Import (kept from the prior sidebar's affordances) */}
      <div className="flex items-center gap-1 px-1 pt-2">
        <button
          type="button"
          onClick={() => setShowNewProject(true)}
          className="flex-1 rounded-control border border-chrome-border/15 px-2 py-1.5 text-xs text-chrome-text-secondary hover:text-chrome-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
        >
          + New project
        </button>
        <button
          type="button"
          onClick={() => setShowImport(true)}
          aria-label="Import a project from a file"
          title="Import a project from a file"
          className="w-8 h-8 flex items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 8V1m0 0L3.5 3.5M6 1l2.5 2.5M2 8.5v1A1.5 1.5 0 003.5 11h5A1.5 1.5 0 0010 9.5v-1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Tier 2 "This project" — the active project's header card plus its
 * methodology-adaptive grouped views. The view composition is read from
 * `useGroupedProjectViews` — the SAME hook the TopBar `ViewTabs` consumes — so the
 * rail can never silently drop a view the bar shows (issue 1642, the regression
 * firewall). Route segments are unchanged (rule 108): rows link to
 * `/projects/:id/:view`.
 */
function ProjectViewsTier({
  projectId,
  isDrawer,
  onClose,
}: {
  projectId: string;
  isDrawer: boolean;
  onClose?: () => void;
}) {
  const { groups, labelFor, standaloneLeading, standaloneTrailing } =
    useGroupedProjectViews(projectId);
  const project = useProject(projectId);
  const { data: programs } = usePrograms();
  const { user } = useCurrentUser();
  // The Settings row targets `/projects/:id/settings`, which `RequireAdminSettings`
  // bounces to personal notification prefs for a non-admin (#2147). Gate the row on
  // the same predicate the guard uses (strict `!== false`, so it stays visible while
  // the role signal loads and never flash-hides for an admin — mirrors #2033).
  const canAccessProjectSettings = user?.can_access_admin_settings !== false;

  const name = project.data?.name ?? 'Project';
  const programId = project.data?.program ?? null;
  const program = programs?.find((p) => p.id === programId) ?? null;
  const programName = project.data?.program_detail?.name ?? null;
  const health = PROJECT_HEALTH_STATE[project.data?.health ?? 'AUTO'] ?? 'unknown';
  // Server-resolved preset (web-rule 196) — the same value the bar's
  // `MethodologyIndicator` reads (#1907, restoring the signal #1680 relocated here);
  // that bar indicator only renders while this card subtitle is hidden (collapsed
  // rail), so the two never show the methodology twice at once.
  const effectiveMethodology = project.data?.effective_methodology ?? 'HYBRID';
  // Two forms of the same fact. The full phrase carries the #2619 "(workspace
  // default)" qualifier and is ~230px wide at `text-xs` — wider than the entire
  // rail, let alone the ~170px this card leaves for text — so it cannot be the
  // *visible* string here at any rail width. It rides the line's `title` instead
  // (rule 255), alongside the collapsed-rail `MethodologyIndicator` tooltip that
  // already carries it. Omitting `inherited` degrades `methodologyStatusLabel` to
  // the plain "Hybrid methodology" by design, which is what fits.
  const methodologyFull = methodologyStatusLabel(
    effectiveMethodology,
    project.data?.inherited_methodology,
  );
  const methodologyShort = methodologyStatusLabel(effectiveMethodology);
  const subtitleTitle = programName ? `${programName} · ${methodologyFull}` : methodologyFull;
  const OverviewIcon = VIEW_TAB_META[standaloneLeading].Icon;
  const closeDrawer = () => {
    if (isDrawer) onClose?.();
  };

  return (
    <>
      {/* Header row — the "This project" label plus the relocated Customize-views
          control (#1680): a `flex-wrap justify-between` row so ViewsMenu's gear sits
          at the right and its in-flow `basis-full` panel wraps to a full-width line
          beneath, pushing the card down (the rail's overflow would clip a floating
          menu). */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 pr-1">
        <h2 className={GROUP_LABEL}>This project</h2>
        <ViewsMenu />
      </div>
      {/* Project header card — program identity SQUARE (rule 158), name + a
          program·methodology subtitle (the methodology label relocated from the bar
          in #1680, web-rule 196), and a right-aligned health CIRCLE whose word rides
          its aria-label (rule 6). Never a shadow for the raise (rule 1). */}
      <div className="mb-1 flex items-center gap-2 rounded-card border border-chrome-border/15 bg-app-canvas p-2">
        <ProgramIdentitySquare
          program={program ?? { color: null, code: '', name: programName ?? name }}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-chrome-text-primary">{name}</p>
          {/* Program name truncates first — it carries the heavier shrink factor, so
              it gives up its width before the "how it runs" signal does. But the
              methodology must still be able to truncate as a last resort: a `shrink-0`
              span whose text exceeds the card simply overflows it, and the rail's
              `overflow-hidden` then cuts the phrase off mid-word with nothing marking
              it as truncated. `title` keeps the full line recoverable (rule 255). */}
          <p
            className="flex items-center gap-1 text-xs text-chrome-text-secondary"
            title={subtitleTitle}
          >
            {programName && <span className="min-w-0 shrink-[9999] truncate">{programName}</span>}
            {programName && (
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
            )}
            <span className="min-w-0 truncate">{methodologyShort}</span>
          </p>
        </div>
        <span role="img" aria-label={HEALTH_LABEL[health]} className="shrink-0">
          <HealthDot state={health} />
        </span>
      </div>

      {/* The project view links (Overview + grouped views) live in their own `View`
          navigation landmark — the same name the TopBar's view-tab strip carried
          before #1643 removed it. Moving the landmark here (the rail now owns view
          switching, #1642) keeps the one canonical `View` nav in the tree, so the
          leaf in the top bar stays a plain label, not a second view nav (rule 172). */}
      <nav aria-label="View">
        {/* Overview leads standalone (no group label). */}
        <NavLink
          to={`/projects/${projectId}/overview`}
          onClick={closeDrawer}
          className={({ isActive }) => rowClass(isActive)}
        >
          <OverviewIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{labelFor(standaloneLeading)}</span>
        </NavLink>

        {/* Grouped views (PLAN / DELIVER / TRACK / PEOPLE). The visible mono header
            is aria-hidden so the group name is not double-read (rule 172/171). */}
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={`${group.label} views`}>
            <h2 aria-hidden="true" className={GROUP_LABEL}>
              {group.id}
            </h2>
            {group.visibleViews.map((view) => {
              const Icon = VIEW_TAB_META[view].Icon;
              return (
                <NavLink
                  key={view}
                  to={`/projects/${projectId}/${view}`}
                  onClick={closeDrawer}
                  className={({ isActive }) => rowClass(isActive)}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{labelFor(view)}</span>
                </NavLink>
              );
            })}
          </div>
        ))}

        {/* Settings trails standalone (no group label), mirroring the program tier's
            `PROGRAM_VIEWS` Settings row (#2045). Without it the two Tier-2 siblings
            diverge and desktop project settings (members/access, working calendars —
            a getting-started step) is reachable only via the UserMenu. Hidden for
            non-admins so it never dumps them on the guard's redirect target (#2147). */}
        {canAccessProjectSettings &&
          (() => {
            const SettingsIcon = VIEW_TAB_META[standaloneTrailing].Icon;
            return (
              <NavLink
                to={`/projects/${projectId}/${standaloneTrailing}`}
                onClick={closeDrawer}
                className={({ isActive }) => rowClass(isActive)}
              >
                <SettingsIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{labelFor(standaloneTrailing)}</span>
              </NavLink>
            );
          })()}
      </nav>
    </>
  );
}

/**
 * Tier 2 "This program" — the program analog of `ProjectViewsTier`. When the URL
 * is `/programs/:id/*` the rail owns program-view switching, exactly as it owns
 * project-view switching on `/projects/:id/*`. It sits in the SAME Tier-2 slot,
 * directly below the "You" card and above the "Jump"/Browse tier — so it reads as
 * the in-context sibling of "This project", not a new nav pattern (reuses
 * `rowClass`, `GROUP_LABEL`, and the header-card treatment). The Programs tree
 * itself stays in Tier 3's Browse switcher; this tier is the *active* program's
 * views, the tree is the cross-program jump list.
 *
 * The view set is the fixed program surface (ADR-0095) — Overview · Backlog ·
 * Projects · Schedule · Resources · Members · Assets · Settings — driven from the
 * shared `PROGRAM_VIEWS` const so it can never drift from what the routes expose.
 *
 * This tier is the sole navigation home for these views after `ProgramTabs` was
 * removed from the TopBar (#1920, resolving the #1643 deferral); before it,
 * backlog/schedule/resources/members/assets had no non-URL entry point on desktop.
 * The nav landmark keeps the `Program` accessible name the removed strip carried,
 * so it stays the one canonical `Program` nav in the tree and existing
 * `getByRole('navigation', { name: 'Program' })` locators still resolve — just
 * relocated to the rail.
 */
function ProgramViewsTier({
  programId,
  isDrawer,
  onClose,
}: {
  programId: string;
  isDrawer: boolean;
  onClose?: () => void;
}) {
  const { data: programs } = usePrograms();
  const program = programs?.find((p) => p.id === programId) ?? null;
  const name = program?.name ?? 'Program';
  const closeDrawer = () => {
    if (isDrawer) onClose?.();
  };

  return (
    <>
      <h2 className={GROUP_LABEL}>This program</h2>
      {/* Program header card — identity SQUARE (rule 158) + name, raised by a
          BORDER not a shadow (rule 1), mirroring the project header card so the
          two in-context tiers read as siblings. */}
      <div className="mb-1 flex items-center gap-2 rounded-card border border-chrome-border/15 bg-app-canvas p-2">
        <ProgramIdentitySquare program={program ?? { color: null, code: '', name }} size="sm" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-chrome-text-primary">
          {name}
        </p>
      </div>

      {/* Program view links — the sole nav home for these views since #1920 moved
          them off the TopBar. Keeps the `Program` landmark name (see the tier
          docstring). Settings stays active across its `/settings/*` sub-routes via
          NavLink's default prefix matching (no `end`), matching the old tab. */}
      <nav aria-label="Program">
        {PROGRAM_VIEWS.map(({ view, label, Icon }) => (
          <NavLink
            key={view}
            to={`/programs/${programId}/${view}`}
            onClick={closeDrawer}
            className={({ isActive }) => rowClass(isActive)}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}

/** One project row — health dot + name (opens overview) + open-task count + a pin toggle. */
function ProjectRow({
  id,
  name,
  health,
  openTaskCount,
  pinned,
  onOpen,
}: {
  id: string;
  name: string;
  health: HealthState;
  openTaskCount: number | null;
  pinned: boolean;
  onOpen: () => void;
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
        className="min-w-0 flex-1 truncate rounded-control text-left focus:outline-none focus:ring-2 focus:ring-brand-primary"
      >
        {name}
      </button>
      {/* Right-aligned open-task count (rule 7: mono numerals). aria-hidden —
          the count is already in the name button's aria-label above. The pin
          toggle reveals on hover and overlays this when present. */}
      {openTaskCount != null && openTaskCount > 0 && (
        <span
          aria-hidden="true"
          className="tppm-mono shrink-0 text-xs text-chrome-text-secondary md:group-hover:hidden"
        >
          {openTaskCount}
        </span>
      )}
      <PinToggle kind="project" id={id} name={name} pinned={pinned} size="sm" tone="chrome" />
    </div>
  );
}
