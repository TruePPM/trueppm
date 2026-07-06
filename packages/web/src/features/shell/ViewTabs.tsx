import { NavLink, useLocation, useMatch } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useGroupedProjectViews } from '@/features/shell/useGroupedProjectViews';
import { VIEW_TAB_META, type ViewIconType } from '@/features/shell/viewMeta';
import type { Methodology } from '@/types';

type IconType = ViewIconType;

// Render metadata (label + icon per view key) is shared via `viewMeta.ts` so the
// bar, the Customize-views menu (ADR-0139), and the ⌘K palette never drift.
const TAB_META = VIEW_TAB_META;

// Mono group-header + workspace-label token (rule 36/101).
const GROUP_LABEL =
  'self-center px-2 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary select-none whitespace-nowrap';

function Divider() {
  return <span aria-hidden="true" className="self-center mx-1 h-5 w-px bg-chrome-border" />;
}

interface TabProps {
  projectId: string;
  view: string;
  label: string;
  Icon: IconType;
  currentView: string;
}

function Tab({ projectId, view, label, Icon, currentView }: TabProps) {
  const isActive = currentView === view;
  return (
    <NavLink
      to={`/projects/${projectId}/${view}`}
      replace
      className={[
        'flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors',
        // Inset ring (rule 174): these tabs live in the ShellNavScroller's
        // overflow-x-auto region, which clips an offset ring top/bottom (rule 137 precedent).
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
        isActive
          ? 'border-brand-primary text-brand-primary'
          : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon
        className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
        aria-hidden="true"
      />
      {label}
    </NavLink>
  );
}

/**
 * v2 grouped project view bar (ADR-0128 §A, amended by ADR-0195 and ADR-0203). Replaces the
 * flat 11-tab strip with methodology-adaptive PLAN / DELIVER / TRACK / PEOPLE groups (Overview
 * leads standalone, Settings trails standalone), method-filtered via the ADR-0041 matrix.
 * The DELIVER group co-locates the sprint circuit (Backlog · Sprints · Board) on
 * AGILE/HYBRID; WATERFALL has no DELIVER group and keeps Board in TRACK. Route segments are
 * unchanged (rule 108): links are still `/projects/:id/:view`.
 *
 * Project-scoped: returns null off a project route (the `useProjectId()` null path,
 * which also covers My Work / Inbox / Portfolio / Program / workspace settings —
 * `ProgramTabs` owns program routes per ADR-0095) and on project settings routes
 * (the SettingsShell carries its own chrome — rule 123 / ADR-0128 §C).
 */
export function ViewTabs() {
  const location = useLocation();
  const projectId = useProjectId();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');
  // The grouped composition is shared with the left-rail "This project" tier via
  // this one hook (issue 1642) — the bar and the rail can never drift because both
  // read the same methodology-filtered, hidden-views-aware, role-gated groups.
  const { groups, labelFor, standaloneLeading, standaloneTrailing } =
    useGroupedProjectViews(projectId);

  if (!projectId || onSettingsRoute) return null;

  // Derive active view from the path segment immediately after the projectId.
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = pathSegments.indexOf(projectId ?? '');
  const currentView =
    (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? 'overview';

  return (
    <nav aria-label="View" className="hidden md:flex items-stretch h-full">
      <Tab
        projectId={projectId}
        view={standaloneLeading}
        label={labelFor(standaloneLeading)}
        Icon={TAB_META[standaloneLeading].Icon}
        currentView={currentView}
      />

      {groups.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={`${group.label} views`}
          className="flex items-stretch h-full"
        >
          <Divider />
          <span aria-hidden="true" className={GROUP_LABEL}>
            {group.id}
          </span>
          {group.visibleViews.map((view) => (
            <Tab
              key={view}
              projectId={projectId}
              view={view}
              label={labelFor(view)}
              Icon={TAB_META[view].Icon}
              currentView={currentView}
            />
          ))}
        </div>
      ))}

      <Divider />
      <Tab
        projectId={projectId}
        view={standaloneTrailing}
        label={labelFor(standaloneTrailing)}
        Icon={TAB_META[standaloneTrailing].Icon}
        currentView={currentView}
      />
    </nav>
  );
}

const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

// Compact 2-letter methodology code shown below xl (issue 1469), where the full
// "{METHOD} Workspace" text is hidden. The badge's accessible name is always the
// full methodology (rule 6 / WCAG 1.4.1) — the two letters are visual shorthand,
// never the sole signal, so it carries `role="img"` + `aria-label` rather than
// relying on the letters alone.
const METHOD_CODE: Record<Methodology, string> = {
  AGILE: 'AG',
  WATERFALL: 'WF',
  HYBRID: 'HY',
};

// Outlined chip in the same mono/secondary token family as GROUP_LABEL (rule 36/101),
// reusing the shell's existing chip look (rounded-chip + chrome-border, cf. Sidebar
// ⌘K kbd). Display is set entirely in the responsive chain at the call site so it
// never collides with the base class.
const METHOD_BADGE =
  'self-center items-center rounded-chip border border-chrome-border/20 px-1.5 py-0.5 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary select-none';

/**
 * Right-aligned methodology tag for the v2 view row (ADR-0128 §A). Lives at the
 * left edge of the TopBar's right cluster (just before the health cluster) so it is
 * reliably right-aligned without making the tab nav grow. Self-gates exactly like
 * `ViewTabs` (off-project / settings routes).
 *
 * Two responsive forms so the methodology is identifiable at a glance from md up
 * (issue 1469): a compact 2-letter badge from md to just below xl, and the full
 * "{METHOD} Workspace" text at xl and up. Previously the full text was the only
 * signal (`hidden xl:inline`), which vanished below 1280px — exactly where most
 * laptops sit.
 */
export function MethodWorkspaceLabel() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');

  if (!projectId || onSettingsRoute) return null;

  // Show the server-resolved preset (ADR-0107, issue 955), matching the tab gate.
  const methodology = project?.effective_methodology ?? 'HYBRID';
  const label = METHOD_LABEL[methodology];
  return (
    <>
      {/* Compact badge: md → just below xl. `role="img"` exposes the full
          methodology as the accessible name; the "HY"/"WF"/"AG" glyphs are a
          visual shorthand only. */}
      <span
        role="img"
        aria-label={`${label} workspace`}
        className={`${METHOD_BADGE} hidden md:inline-flex xl:hidden`}
      >
        {METHOD_CODE[methodology]}
      </span>
      {/* Full text: xl and up (unchanged behavior). */}
      <span className={`${GROUP_LABEL} hidden xl:inline`}>{label} Workspace</span>
    </>
  );
}
