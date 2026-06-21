import { useNavigate } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';
import { modifierKeyLabel } from '@/lib/platform';
import { Breadcrumb, type BreadcrumbItem } from '@/components/Breadcrumb';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { Logo } from './Logo';
import { ViewTabs, MethodWorkspaceLabel } from './ViewTabs';
import { ViewsMenu } from './ViewsMenu';
import { ProgramTabs } from './ProgramTabs';
import { ShellNavScroller } from './ShellNavScroller';
import { HealthCluster } from './HealthCluster';
import { CreateMenu } from './CreateMenu';
import { TaskRunIndicator } from './TaskRunIndicator';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';

interface Props {
  onHamburgerClick: () => void;
}

/**
 * v2 unified shell bar (ADR-0134) — collapses the former two-row top region
 * (`ContextBar` h-10 + `TopBar` h-12, ~88px) into one 56px bar, removing the
 * redundant breadcrumb, the split right cluster, and the duplicate theme toggle.
 *
 * Left → right: mobile hamburger / desktop rail re-open ≡ · adaptive identity ·
 * scrollable view-or-program nav · pinned right cluster (method label · health
 * cluster · context-aware + New · run indicator · presence · notifications · user
 * menu, which is the single home for the theme toggle).
 *
 * Adaptive identity (the ADR-0134 unlock): the breadcrumb duplicates the left rail
 * when the rail is open, so on desktop it renders ONLY when the rail is hidden
 * (`sidebarCollapsed`) — where it becomes the only wayfinding and the hidden rail
 * has freed the width for it. When the rail is open it is `md:hidden`
 * (display:none — removed from the a11y tree, never `aria-hidden`). On mobile the
 * rail is a drawer, so identity always shows. Presence (ADR-0127) stays ephemeral:
 * who is online now, never aggregated, empty off-project.
 */
export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);
  const navigate = useNavigate();

  const projectId = useProjectId();
  const programId = useProgramId();
  const { data: project } = useProject(projectId);
  // A project's program drives the intermediate breadcrumb segment + identity
  // square; on a program route the program is itself the leaf. Chained id keeps the
  // hook call unconditional (disabled when falsy).
  const effectiveProgramId = project?.program_detail?.id ?? programId;
  const { data: program } = useProgram(effectiveProgramId);

  // Ephemeral presence: collaborators currently viewing this project, minus self.
  // Empty off-project (hook disabled when projectId is undefined).
  const { user: currentUser } = useCurrentUser();
  const onlineUsers = useProjectPresence(projectId).filter((u) => u.user_id !== currentUser?.id);

  // Uploaded workspace logo (#969) brands the breadcrumb root. Falls back to no
  // leading mark when unset — the product <Logo/> on the left rail is unaffected.
  const { data: workspace } = useWorkspaceSettings();
  const workspaceLogo = workspace?.logoUrl ? (
    <img
      src={workspace.logoUrl}
      alt=""
      className="w-4 h-4 rounded-sm object-contain shrink-0"
    />
  ) : undefined;

  const items: BreadcrumbItem[] = [{ label: 'Workspace', to: '/', leading: workspaceLogo }];
  if (project) {
    if (program) {
      items.push({
        label: program.name,
        to: `/programs/${program.id}/overview`,
        leading: <ProgramIdentitySquare program={program} size="sm" />,
      });
    } else if (project.program_detail) {
      items.push({
        label: project.program_detail.name,
        to: `/programs/${project.program_detail.id}/overview`,
      });
    }
    items.push({ label: project.name });
  } else if (program) {
    items.push({
      label: program.name,
      leading: <ProgramIdentitySquare program={program} size="sm" />,
    });
  }

  function handleTaskNavigate(id: string) {
    setSelectedTaskId(id);
    scrollToTask(id);
    void navigate('/');
  }

  return (
    <header className="flex items-center h-14 px-3 gap-2 bg-chrome-surface border-b border-chrome-border">
      {/* Hamburger — visible only below md (opens the rail drawer) */}
      <button
        type="button"
        onClick={onHamburgerClick}
        aria-label="Open sidebar"
        aria-expanded={!sidebarCollapsed}
        className="md:hidden flex shrink-0 items-center justify-center w-11 h-11 rounded-control text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect y="3" width="20" height="2" rx="1" />
          <rect y="9" width="20" height="2" rx="1" />
          <rect y="15" width="20" height="2" rx="1" />
        </svg>
      </button>

      {/* Desktop rail re-open ≡ — always visible: the only affordance that re-opens
          the 0px-hidden rail (ADR-0127 Decision D); ⌘/Ctrl+B and ⌘K also reach it. */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Show navigation' : 'Hide navigation'}
        aria-controls="primary-nav-rail"
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Show' : 'Hide'} navigation (${modifierKeyLabel()}B)`}
        className="hidden md:inline-flex shrink-0 w-8 h-8 items-center justify-center rounded-control text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <line x1="2" y1="4" x2="14" y2="4" strokeLinecap="round" />
          <line x1="2" y1="8" x2="14" y2="8" strokeLinecap="round" />
          <line x1="2" y1="12" x2="14" y2="12" strokeLinecap="round" />
        </svg>
      </button>

      {/* Brand — mobile only (desktop carries it in the left rail). */}
      <span className="md:hidden shrink-0">
        <Logo />
      </span>

      {/* Adaptive identity (ADR-0134): always on mobile (rail is a drawer); on
          desktop only when the rail is hidden — else `md:hidden` removes it from the
          a11y tree so it never duplicates the rail's highlighted program/project. */}
      <Breadcrumb
        items={items}
        className={[
          'shrink min-w-0 max-w-[16rem] md:max-w-[22rem]',
          sidebarCollapsed ? 'block' : 'block md:hidden',
        ].join(' ')}
      />

      {/* View / program nav — scrolls horizontally only when it overflows; the right
          cluster stays pinned. ViewTabs / ProgramTabs are mutually exclusive (ADR-0095)
          so exactly one renders. */}
      <ShellNavScroller>
        <ViewTabs />
        <ProgramTabs />
      </ShellNavScroller>

      {/* Right cluster — pinned, never compresses. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {/* Customize views (ADR-0139) — per-user show/hide of the view tabs; sits
            adjacent to the tab strip, self-suppresses off-project/settings. */}
        <ViewsMenu />

        {/* "{METHOD} Workspace" tag — first to drop as width tightens (hidden xl:inline). */}
        <MethodWorkspaceLabel />

        {/* v2 methodology-adaptive health cluster (ADR-0128) — project routes only;
            collapses to "Health ▾" below lg. Stays pinned, never behind a tab scroll. */}
        <HealthCluster onTaskNavigate={handleTaskNavigate} />

        {/* Context-aware "+ New" (ADR-0131) — self-gates by route + RBAC. */}
        <CreateMenu />

        {/* Background operations indicator — visible only when runs are active. */}
        <TaskRunIndicator />

        {/* Online collaborators — desktop only (hidden md:flex inside the component);
            renders nothing off-project or when no one else is online. */}
        <PresenceAvatarStack users={onlineUsers} />

        {/* Notification bell — visible at all widths. */}
        <NotificationBell />

        {/* User menu — avatar chip; the single home for the theme toggle, plus
            notifications, keyboard shortcuts, and sign out. */}
        <UserMenu />
      </div>
    </header>
  );
}
