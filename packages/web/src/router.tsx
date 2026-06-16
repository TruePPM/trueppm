import { createBrowserRouter, Navigate, useNavigate } from 'react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { AppShell } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/project/ProjectShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { RequireAdminSettings } from '@/features/settings/RequireAdminSettings';

// Route-level code splitting — each chunk is loaded only when the route is
// first visited, keeping the initial bundle (login + shell) minimal.
const ProjectOverviewPage = lazy(() =>
  import('@/features/project/ProjectOverviewPage').then((m) => ({
    default: m.ProjectOverviewPage,
  })),
);
const ScheduleView = lazy(() =>
  import('@/features/schedule/ScheduleView').then((m) => ({ default: m.ScheduleView })),
);
const TaskDetailPage = lazy(() =>
  import('@/features/schedule/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })),
);
const GridView = lazy(() =>
  import('@/features/grid/GridView').then((m) => ({ default: m.GridView })),
);
const BoardView = lazy(() =>
  import('@/features/board/BoardView').then((m) => ({ default: m.BoardView })),
);
const SprintsView = lazy(() =>
  import('@/features/sprints/SprintsView').then((m) => ({ default: m.SprintsView })),
);
const ProductBacklogPage = lazy(() =>
  import('@/features/project/backlog/ProductBacklogPage').then((m) => ({
    default: m.ProductBacklogPage,
  })),
);
const CalendarView = lazy(() =>
  import('@/features/calendar/CalendarView').then((m) => ({ default: m.CalendarView })),
);
const ResourceView = lazy(() =>
  import('@/features/resource/ResourceView').then((m) => ({ default: m.ResourceView })),
);
const HeatmapPage = lazy(() =>
  import('@/features/resource/HeatmapPage').then((m) => ({ default: m.HeatmapPage })),
);
const TeamView = lazy(() =>
  import('@/features/roster/TeamView').then((m) => ({ default: m.TeamView })),
);
const RosterPage = lazy(() =>
  import('@/features/roster/RosterPage').then((m) => ({ default: m.RosterPage })),
);
const RiskRegisterView = lazy(() =>
  import('@/features/risk/RiskRegisterView').then((m) => ({ default: m.RiskRegisterView })),
);
const ReportsView = lazy(() =>
  import('@/features/reports/ReportsView').then((m) => ({ default: m.ReportsView })),
);
const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })),
);
const MyWorkPage = lazy(() =>
  import('@/features/me/MyWorkPage').then((m) => ({ default: m.MyWorkPage })),
);

const NotificationListPage = lazy(() =>
  import('@/features/me/NotificationListPage').then((m) => ({ default: m.NotificationListPage })),
);

const NotificationPreferencesPage = lazy(() =>
  import('@/features/me/NotificationPreferencesPage').then((m) => ({
    default: m.NotificationPreferencesPage,
  })),
);

const MyGeneralPreferencesPage = lazy(() =>
  import('@/features/me/MyGeneralPreferencesPage').then((m) => ({
    default: m.MyGeneralPreferencesPage,
  })),
);

const ConnectedAccountsPage = lazy(() =>
  import('@/features/me/ConnectedAccountsPage').then((m) => ({
    default: m.ConnectedAccountsPage,
  })),
);
const ProgramListPage = lazy(() =>
  import('@/features/programs/ProgramListPage').then((m) => ({ default: m.ProgramListPage })),
);
const PortfolioUpsellPage = lazy(() =>
  import('@/features/portfolio/PortfolioUpsellPage').then((m) => ({ default: m.PortfolioUpsellPage })),
);
const ProgramShell = lazy(() =>
  import('@/features/programs/ProgramShell').then((m) => ({ default: m.ProgramShell })),
);
const ProgramBacklogPage = lazy(() =>
  import('@/features/programs/backlog/ProgramBacklogPage').then((m) => ({
    default: m.ProgramBacklogPage,
  })),
);
const ProgramOverviewPage = lazy(() =>
  import('@/features/programs/ProgramOverviewPage').then((m) => ({
    default: m.ProgramOverviewPage,
  })),
);
const ProgramViewProjectsPage = lazy(() =>
  import('@/features/programs/ProgramProjectsPage').then((m) => ({
    default: m.ProgramProjectsPage,
  })),
);
const ProgramResourcesPage = lazy(() =>
  import('@/features/programs/resources/ProgramResourcesPage').then((m) => ({
    default: m.ProgramResourcesPage,
  })),
);
const ProgramMembersTab = lazy(() =>
  import('@/features/programs/members/ProgramMembersTab').then((m) => ({
    default: m.ProgramMembersTab,
  })),
);

// ── Project settings ──────────────────────────────────────────────────────────
const ProjectSettingsPage = lazy(() =>
  import('@/features/settings/ProjectSettingsPage').then((m) => ({
    default: m.ProjectSettingsPage,
  })),
);
const ProjectSettingsIndex = lazy(() =>
  import('@/features/settings/ProjectSettingsPage').then((m) => ({
    default: m.ProjectSettingsIndex,
  })),
);
const ProjectGeneralPage = lazy(() =>
  import('@/features/settings/project/ProjectGeneralPage').then((m) => ({
    default: m.ProjectGeneralPage,
  })),
);
const ProjectAccessPage = lazy(() =>
  import('@/features/settings/project/ProjectAccessPage').then((m) => ({
    default: m.ProjectAccessPage,
  })),
);
const ProjectMethodologyPage = lazy(() =>
  import('@/features/settings/project/ProjectMethodologyPage').then((m) => ({
    default: m.ProjectMethodologyPage,
  })),
);
const ProjectTeamPage = lazy(() =>
  import('@/features/settings/team/ProjectTeamPage').then((m) => ({
    default: m.ProjectTeamPage,
  })),
);
const ProjectSignalPrivacyPage = lazy(() =>
  import('@/features/settings/signalPrivacy/ProjectSignalPrivacyPage').then((m) => ({
    default: m.ProjectSignalPrivacyPage,
  })),
);
const ProjectGuardrailsPage = lazy(() =>
  import('@/features/settings/project/ProjectGuardrailsPage').then((m) => ({
    default: m.ProjectGuardrailsPage,
  })),
);
const ProjectWorkflowPage = lazy(() =>
  import('@/features/settings/project/ProjectWorkflowPage').then((m) => ({
    default: m.ProjectWorkflowPage,
  })),
);
const ProjectIntegrationsPage = lazy(() =>
  import('@/features/settings/project/ProjectIntegrationsPage').then((m) => ({
    default: m.ProjectIntegrationsPage,
  })),
);
const ProjectNotificationsPage = lazy(() =>
  import('@/features/settings/project/ProjectNotificationsPage').then((m) => ({
    default: m.ProjectNotificationsPage,
  })),
);
const ProjectArchivePage = lazy(() =>
  import('@/features/settings/project/ProjectArchivePage').then((m) => ({
    default: m.ProjectArchivePage,
  })),
);
// ── Workspace settings ────────────────────────────────────────────────────────
const WorkspaceSettingsPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceSettingsPage').then((m) => ({
    default: m.WorkspaceSettingsPage,
  })),
);
const WorkspaceSettingsIndex = lazy(() =>
  import('@/features/settings/workspace/WorkspaceSettingsPage').then((m) => ({
    default: m.WorkspaceSettingsIndex,
  })),
);
const WorkspaceGeneralPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceGeneralPage').then((m) => ({
    default: m.WorkspaceGeneralPage,
  })),
);
const WorkspaceMembersPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceMembersPage').then((m) => ({
    default: m.WorkspaceMembersPage,
  })),
);
const WorkspaceGroupsPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceGroupsPage').then((m) => ({
    default: m.WorkspaceGroupsPage,
  })),
);
const WorkspaceRolesPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceRolesPage').then((m) => ({
    default: m.WorkspaceRolesPage,
  })),
);
const WorkspaceMethodologyPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceMethodologyPage').then((m) => ({
    default: m.WorkspaceMethodologyPage,
  })),
);
const WorkspaceEmailPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceEmailPage').then((m) => ({
    default: m.WorkspaceEmailPage,
  })),
);
const IntegrationsRedirect = lazy(() =>
  import('@/features/settings/workspace/IntegrationsRedirect').then((m) => ({
    default: m.IntegrationsRedirect,
  })),
);
const WorkspaceDangerPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceDangerPage').then((m) => ({
    default: m.WorkspaceDangerPage,
  })),
);
const SystemHealthOverviewPage = lazy(() =>
  import('@/features/settings/workspace/systemHealth/SystemHealthOverviewPage').then((m) => ({
    default: m.SystemHealthOverviewPage,
  })),
);
const DeadLetterInspectorPage = lazy(() =>
  import('@/features/settings/workspace/systemHealth/DeadLetterInspectorPage').then((m) => ({
    default: m.DeadLetterInspectorPage,
  })),
);
const RetentionPurgePage = lazy(() =>
  import('@/features/settings/workspace/systemHealth/RetentionPurgePage').then((m) => ({
    default: m.RetentionPurgePage,
  })),
);
const InviteAcceptPage = lazy(() =>
  import('@/features/settings/workspace/InviteAcceptPage').then((m) => ({
    default: m.InviteAcceptPage,
  })),
);

// ── Program settings ──────────────────────────────────────────────────────────
const ProgramSettingsPage = lazy(() =>
  import('@/features/settings/ProgramSettingsPage').then((m) => ({
    default: m.ProgramSettingsPage,
  })),
);
const ProgramSettingsIndex = lazy(() =>
  import('@/features/settings/ProgramSettingsPage').then((m) => ({
    default: m.ProgramSettingsIndex,
  })),
);
const ProgramSettingsGeneralPage = lazy(() =>
  import('@/features/settings/program/ProgramGeneralPage').then((m) => ({
    default: m.ProgramGeneralPage,
  })),
);
const ProgramSettingsProjectsPage = lazy(() =>
  import('@/features/settings/program/ProgramProjectsPage').then((m) => ({
    default: m.ProgramProjectsPage,
  })),
);
const ProgramSettingsAccessPage = lazy(() =>
  import('@/features/settings/program/ProgramAccessPage').then((m) => ({
    default: m.ProgramAccessPage,
  })),
);
const ProgramRollupPage = lazy(() =>
  import('@/features/settings/program/ProgramRollupPage').then((m) => ({
    default: m.ProgramRollupPage,
  })),
);
const ProgramCadencePage = lazy(() =>
  import('@/features/settings/program/ProgramCadencePage').then((m) => ({
    default: m.ProgramCadencePage,
  })),
);
const ProgramRiskPolicyPage = lazy(() =>
  import('@/features/settings/program/ProgramRiskPolicyPage').then((m) => ({
    default: m.ProgramRiskPolicyPage,
  })),
);
const ProgramIntegrationsPage = lazy(() =>
  import('@/features/settings/program/ProgramIntegrationsPage').then((m) => ({
    default: m.ProgramIntegrationsPage,
  })),
);
const ProgramArchivePage = lazy(() =>
  import('@/features/settings/program/ProgramArchivePage').then((m) => ({
    default: m.ProgramArchivePage,
  })),
);

/** Fallback rendered inside Suspense while a lazy chunk is loading. */
function RouteLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full text-sm text-neutral-text-secondary">
      Loading…
    </div>
  );
}

/**
 * Redirects `/` to the server-resolved app front door (ADR-0129, #1181).
 *
 * The client holds no role→surface policy: `me.landing.path` is the resolved
 * destination (My Work, a project Overview, or — Enterprise only — Portfolio).
 * We navigate to it through `safeLandingPath`, an allowlist guard mirroring
 * `loginRedirectDest`'s open-redirect protection, so an unreachable or
 * unexpected path degrades to My Work rather than a dead route.
 */
function RootRedirect() {
  const { user, isLoading } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading || !user) return;
    void navigate(safeLandingPath(user.landing?.path), { replace: true });
  }, [user, isLoading, navigate]);

  // Hold the loading state while `me` resolves — never flash a fallback first.
  return (
    <div className="flex items-center justify-center h-full text-sm text-neutral-text-secondary">
      {isLoading ? 'Loading…' : 'Taking you to your home screen…'}
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  // Public route — no auth required. Handles workspace invite token redemption.
  {
    path: '/invite/accept',
    element: (
      <Suspense fallback={<RouteLoadingFallback />}>
        <InviteAcceptPage />
      </Suspense>
    ),
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          // Project-scoped routes — projectId in path for shareable URLs (ADR-0030)
          {
            path: 'projects/:projectId',
            element: <ProjectShell />,
            children: [
              // /projects/:projectId → redirect to overview (canonical landing surface, ADR-0030)
              { index: true, element: <Navigate to="overview" replace /> },
              {
                path: 'overview',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProjectOverviewPage />
                  </Suspense>
                ),
              },
              {
                path: 'schedule',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ScheduleView />
                  </Suspense>
                ),
              },
              {
                path: 'grid',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <GridView />
                  </Suspense>
                ),
              },
              {
                // Expand-to-full-page focus view of a single task (handoff #13).
                path: 'tasks/:taskId',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TaskDetailPage />
                  </Suspense>
                ),
              },
              // Legacy routes — redirect to /grid so old bookmarks and shared
              // links keep working after the WBS / Table consolidation (#334).
              { path: 'wbs', element: <Navigate to="../grid" replace /> },
              { path: 'list', element: <Navigate to="../grid" replace /> },
              {
                path: 'board',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <BoardView />
                  </Suspense>
                ),
              },
              {
                path: 'sprints',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SprintsView />
                  </Suspense>
                ),
              },
              {
                // ADR-0105 — Product-Owner backlog / grooming view (#494).
                path: 'product-backlog',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProductBacklogPage />
                  </Suspense>
                ),
              },
              {
                path: 'calendar',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <CalendarView />
                  </Suspense>
                ),
              },
              {
                path: 'resources',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TeamView />
                  </Suspense>
                ),
                children: [
                  { index: true, element: <Navigate to="roster" replace /> },
                  { path: 'roster', element: <RosterPage /> },
                  { path: 'allocation', element: <ResourceView /> },
                  { path: 'heatmap', element: <HeatmapPage /> },
                ],
              },
              {
                path: 'risk',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <RiskRegisterView />
                  </Suspense>
                ),
              },
              {
                path: 'reports',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ReportsView />
                  </Suspense>
                ),
              },
              {
                path: 'settings',
                element: (
                  <RequireAdminSettings>
                    <Suspense fallback={<RouteLoadingFallback />}>
                      <ProjectSettingsPage />
                    </Suspense>
                  </RequireAdminSettings>
                ),
                children: [
                  {
                    index: true,
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectSettingsIndex />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'general',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectGeneralPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'access',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectAccessPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'methodology',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectMethodologyPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'team',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectTeamPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'signal-privacy',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectSignalPrivacyPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'workflow',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectWorkflowPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'guardrails',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectGuardrailsPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'integrations',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectIntegrationsPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'notifications',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectNotificationsPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'lifecycle',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectArchivePage />
                      </Suspense>
                    ),
                  },
                  // Legacy redirect — old bookmarks pointing at /settings/members
                  { path: 'members', element: <Navigate to="../access" replace /> },
                ],
              },
            ],
          },
          // Org-level resource catalog
          {
            path: 'resources',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ResourcesPage />
              </Suspense>
            ),
          },
          // My Work — cross-project contributor surface (#499, ADR-0065 Gap 2)
          {
            path: 'me/work',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <MyWorkPage />
              </Suspense>
            ),
          },
          // Notification inbox — mobile-primary, desktop secondary (#311 phase 3).
          {
            path: 'me/notifications',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <NotificationListPage />
              </Suspense>
            ),
          },
          // Per-user general preferences — default landing screen (ADR-0129, #1181).
          // Flat route like the other /me/settings/* pages (no SettingsShell).
          {
            path: 'me/settings/general',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <MyGeneralPreferencesPage />
              </Suspense>
            ),
          },
          // Per-user notification preference matrix (#311 phase 4).
          {
            path: 'me/settings/notifications',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <NotificationPreferencesPage />
              </Suspense>
            ),
          },
          // Per-user IntegrationCredential listing (#587, ADR-0049 §3).
          {
            path: 'me/settings/connected-accounts',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ConnectedAccountsPage />
              </Suspense>
            ),
          },
          // Programs (ADR-0070) — OSS coordination unit for a PM with several
          // related projects. Lives between project (lower) and Enterprise
          // portfolio (higher); see ADR-0030 navigation amendment.
          {
            path: 'programs',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ProgramListPage />
              </Suspense>
            ),
          },
          // Community-edition upsell for the Enterprise Portfolio rollup.
          // The real `/portfolio` route is registered by the enterprise repo via
          // the `routes` slot (ADR-0029); OSS must NOT define it. This static
          // upsell self-redirects to `/portfolio` under the enterprise edition.
          {
            path: 'portfolio-upsell',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <PortfolioUpsellPage />
              </Suspense>
            ),
          },
          {
            path: 'programs/:programId',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ProgramShell />
              </Suspense>
            ),
            children: [
              { index: true, element: <Navigate to="overview" replace /> },
              {
                path: 'overview',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramOverviewPage />
                  </Suspense>
                ),
              },
              {
                path: 'backlog',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramBacklogPage />
                  </Suspense>
                ),
              },
              {
                path: 'projects',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramViewProjectsPage />
                  </Suspense>
                ),
              },
              {
                path: 'resources',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramResourcesPage />
                  </Suspense>
                ),
              },
              {
                path: 'members',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramMembersTab />
                  </Suspense>
                ),
              },
              {
                path: 'settings',
                element: (
                  <RequireAdminSettings>
                    <Suspense fallback={<RouteLoadingFallback />}>
                      <ProgramSettingsPage />
                    </Suspense>
                  </RequireAdminSettings>
                ),
                children: [
                  {
                    index: true,
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramSettingsIndex />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'general',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramSettingsGeneralPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'projects',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramSettingsProjectsPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'access',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramSettingsAccessPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'rollup',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramRollupPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'cadence',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramCadencePage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'risk',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramRiskPolicyPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'integrations',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramIntegrationsPage />
                      </Suspense>
                    ),
                  },
                  {
                    path: 'lifecycle',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramArchivePage />
                      </Suspense>
                    ),
                  },
                ],
              },
            ],
          },
          // Workspace settings — lives outside any project/program scope
          {
            path: 'settings',
            element: (
              <RequireAdminSettings>
                <Suspense fallback={<RouteLoadingFallback />}>
                  <WorkspaceSettingsPage />
                </Suspense>
              </RequireAdminSettings>
            ),
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceSettingsIndex />
                  </Suspense>
                ),
              },
              {
                path: 'general',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceGeneralPage />
                  </Suspense>
                ),
              },
              {
                path: 'members',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceMembersPage />
                  </Suspense>
                ),
              },
              {
                path: 'groups',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceGroupsPage />
                  </Suspense>
                ),
              },
              {
                path: 'roles',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceRolesPage />
                  </Suspense>
                ),
              },
              {
                path: 'methodology',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceMethodologyPage />
                  </Suspense>
                ),
              },
              {
                path: 'email',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceEmailPage />
                  </Suspense>
                ),
              },
              {
                path: 'integrations',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <IntegrationsRedirect />
                  </Suspense>
                ),
              },
              {
                path: 'webhooks',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <IntegrationsRedirect />
                  </Suspense>
                ),
              },
              {
                path: 'danger',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceDangerPage />
                  </Suspense>
                ),
              },
              {
                path: 'health',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SystemHealthOverviewPage />
                  </Suspense>
                ),
              },
              {
                path: 'health/dead-letters',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <DeadLetterInspectorPage />
                  </Suspense>
                ),
              },
              {
                path: 'health/retention',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <RetentionPurgePage />
                  </Suspense>
                ),
              },
            ],
          },
          // Root: redirect to first project overview, or prompt to select one.
          { index: true, element: <RootRedirect /> },
        ],
      },
    ],
  },
  {
    path: '*',
    element: (
      <div className="min-h-screen flex items-center justify-center bg-neutral-surface-raised">
        <div className="text-center">
          <p className="text-4xl font-semibold text-neutral-text-primary">404</p>
          <p className="mt-2 text-sm text-neutral-text-secondary">Page not found</p>
        </div>
      </div>
    ),
  },
]);
