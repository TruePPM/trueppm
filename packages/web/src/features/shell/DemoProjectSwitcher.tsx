import { useNavigate } from 'react-router';
import { ToolbarOverflowMenu } from '@/components/toolbar/ToolbarOverflowMenu';
import { useProject } from '@/hooks/useProject';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';

/**
 * The sample-project switcher inside the merged demo bar (#4050 A1).
 *
 * This is what `ProjectSampleIndicator`'s strip becomes. The strip said "Demo
 * project — part of Atlas Platform Launch" and offered a link away; the
 * switcher says the same thing by *being* the project control, and its menu is
 * the one place a visitor can reach the demo's other sample projects without
 * learning the sidebar first. A first-time evaluator's second question, after
 * "is this real data", is "is there more of it".
 *
 * **Renders nothing off a project route**, and nothing while the program roster
 * is unresolved — a switcher that lists only the project you are already on is
 * a label wearing a chevron. It is a withdrawal, not an error surface (rule
 * 379): a failed roster read collapses to the same answer as "this project has
 * no siblings".
 *
 * **"Manage demo data" is in the footer and gated on workspace admin.** #4049
 * hid that link from the read-only demo entirely, on the reasoning that
 * following it takes `atlas-visitor` to a page where every teardown control
 * refuses them. That reasoning holds for the visitor and only for the visitor:
 * an operator who signs into their own demo deployment with a real admin
 * account is exactly who the link is for, and they are also the only person for
 * whom it is not an admin affordance dangled on a first screen. So the gate is
 * the role, not the deployment mode.
 */
export function DemoProjectSwitcher() {
  const navigate = useNavigate();
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const programId = project?.program_detail?.id;
  const { data: siblings } = useProgramProjects(programId);
  // `null` = still loading or unknowable. Treated as "not an admin": the footer
  // is an escalation, and an escalation offered on an unresolved read is how a
  // visitor ends up on a page that refuses them.
  const isAdmin = useIsWorkspaceAdmin();

  if (!projectId || !project) return null;

  const others = (siblings ?? []).filter((p) => p.id !== projectId);
  const programName = project.program_detail?.name;

  return (
    <ToolbarOverflowMenu
      className="flex-shrink-0"
      triggerTestId="demo-project-switcher"
      triggerAriaLabel={
        programName
          ? `Sample project: ${project.name}, part of ${programName}. Switch project`
          : `Sample project: ${project.name}. Switch project`
      }
      triggerLabel={
        <span className="max-w-[10rem] truncate lg:max-w-[14rem]">{project.name}</span>
      }
      triggerClassName="text-brand-primary"
      width={280}
      sections={[
        {
          id: 'demo-projects',
          label: programName ? `Sample projects in ${programName}` : 'Sample projects',
          items: others.map((p) => ({
            kind: 'action' as const,
            id: p.id,
            label: p.name,
            // Land on the Schedule, not the lens-aware index redirect: the demo's
            // whole first-screen argument is about the schedule, and bouncing a
            // switcher pick through `ProjectIndexRedirect` would send a visitor
            // whose lens resolves to Board somewhere they did not ask to go.
            onSelect: () => void navigate(`/projects/${p.id}/schedule`),
          })),
        },
      ]}
      footer={
        isAdmin === true && project.program_detail ? (
          <button
            type="button"
            onClick={() => void navigate(`/programs/${project.program_detail?.id ?? ''}`)}
            className="w-full px-3 py-2 text-left text-xs text-neutral-text-secondary
              hover:bg-neutral-surface-raised hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
              focus-visible:ring-brand-primary"
          >
            Manage demo data
          </button>
        ) : undefined
      }
    />
  );
}
