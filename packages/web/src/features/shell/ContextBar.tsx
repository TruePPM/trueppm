import { useShellStore } from '@/stores/shellStore';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useProgram } from '@/hooks/useProgram';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { modifierKeyLabel } from '@/lib/platform';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumb, type BreadcrumbItem } from '@/components/Breadcrumb';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { CreateMenu } from './CreateMenu';
import { PresenceAvatarStack } from './PresenceAvatarStack';

/**
 * v2 context bar (shell slice 2, ADR-0127) — a compact persistent row above the
 * content carrying wayfinding (Workspace › Program › Project), the program identity
 * square, the rail re-open ≡ toggle, the presence avatars, and the theme toggle. The
 * ≡ is the only affordance that re-opens the rail once it is hidden (collapse = 0px),
 * so it must always be visible on desktop; ⌘K remains the jump-to power-nav.
 *
 * Presence (#1180, ADR-0127) lives here rather than the view bar because presence is
 * a property of the *context* (who else is in this project), not the active view.
 * It is ephemeral wayfinding only — who is online right now — never aggregated and
 * never reported (Morgan's surveillance line). It self-suppresses off-project:
 * {@link useProjectPresence} is disabled when there is no projectId and the stack
 * renders nothing when empty, so it never appears on workspace/program routes.
 */
export function ContextBar() {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);

  const projectId = useProjectId();
  const programId = useProgramId();
  const { data: project } = useProject(projectId);
  // A project's program drives the intermediate breadcrumb segment + identity
  // square; on a program route the program is itself the leaf. Chained id keeps
  // the hook call unconditional (disabled when falsy).
  const effectiveProgramId = project?.program_detail?.id ?? programId;
  const { data: program } = useProgram(effectiveProgramId);

  // Ephemeral presence: collaborators currently viewing this project, minus self.
  // Empty off-project (hook disabled when projectId is undefined).
  const { user: currentUser } = useCurrentUser();
  const onlineUsers = useProjectPresence(projectId).filter(
    (u) => u.user_id !== currentUser?.id,
  );

  const items: BreadcrumbItem[] = [{ label: 'Workspace', to: '/' }];
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

  return (
    <div className="flex items-center gap-3 h-10 shrink-0 px-3 bg-chrome-surface border-b border-chrome-border/8">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Show navigation' : 'Hide navigation'}
        aria-controls="primary-nav-rail"
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Show' : 'Hide'} navigation (${modifierKeyLabel()}B)`}
        className="hidden md:inline-flex shrink-0 w-8 h-8 items-center justify-center rounded text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <line x1="2" y1="4" x2="14" y2="4" strokeLinecap="round" />
          <line x1="2" y1="8" x2="14" y2="8" strokeLinecap="round" />
          <line x1="2" y1="12" x2="14" y2="12" strokeLinecap="round" />
        </svg>
      </button>

      <Breadcrumb items={items} className="flex-1" />

      {/* Context-aware "+ New" (ADR-0131, 1179) — self-gates by route + RBAC. */}
      <CreateMenu />

      {/* Online collaborators (#1180) — desktop only (hidden md:flex inside the
          component); renders nothing off-project or when no one else is online. */}
      <PresenceAvatarStack users={onlineUsers} />

      <ThemeToggle className="hidden md:flex shrink-0" />
    </div>
  );
}
