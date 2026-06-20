import { createBrowserRouter, Navigate, useNavigate } from 'react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { AppShell } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/project/ProjectShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { RequireAdminSettings } from '@/features/settings/RequireAdminSettings';
import { SectionRedirect } from '@/features/settings/SectionRedirect';

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

// ── Settings (ADR-0146, #1248) — ONE scrolling page per entity. Each shell
//    renders every section inline; legacy `…/settings/<slug>` paths redirect to
//    `…/settings#<slug>` via SectionRedirect. The section components are imported
//    by the shells directly, so they no longer need per-route lazy chunks. ──────
const ProjectSettingsPage = lazy(() =>
  import('@/features/settings/ProjectSettingsPage').then((m) => ({
    default: m.ProjectSettingsPage,
  })),
);
// ── Workspace settings ────────────────────────────────────────────────────────
const WorkspaceSettingsPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceSettingsPage').then((m) => ({
    default: m.WorkspaceSettingsPage,
  })),
);
// Redirect shim for the OSS-removed Connections routes (ADR-0076) — kept so
// external bookmarks don't 404; Enterprise re-injects the hub via the slot registry.
const IntegrationsRedirect = lazy(() =>
  import('@/features/settings/workspace/IntegrationsRedirect').then((m) => ({
    default: m.IntegrationsRedirect,
  })),
);
const WorkspaceSystemHealthShell = lazy(() =>
  import('@/features/settings/workspace/WorkspaceSystemHealthShell').then((m) => ({
    default: m.WorkspaceSystemHealthShell,
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

// ── Program settings (consolidated, ADR-0146) ──────────────────────────────────
const ProgramSettingsPage = lazy(() =>
  import('@/features/settings/ProgramSettingsPage').then((m) => ({
    default: m.ProgramSettingsPage,
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
                // Consolidated single scrolling page (ADR-0146, #1248). The shell
                // renders every section inline on one mounted page (no Outlet).
                path: 'settings',
                element: (
                  <RequireAdminSettings>
                    <Suspense fallback={<RouteLoadingFallback />}>
                      <ProjectSettingsPage />
                    </Suspense>
                  </RequireAdminSettings>
                ),
              },
              // Legacy per-section paths (pre-0146) redirect to the consolidated
              // page at the matching anchor so bookmarks, emails, and old e2e
              // specs keep working. SIBLINGS of `settings` — the consolidated
              // page renders no Outlet, so these can't be nested under it.
              { path: 'settings/general', element: <SectionRedirect base="/projects/:projectId/settings" anchor="general" /> },
              { path: 'settings/access', element: <SectionRedirect base="/projects/:projectId/settings" anchor="access" /> },
              { path: 'settings/methodology', element: <SectionRedirect base="/projects/:projectId/settings" anchor="methodology" /> },
              { path: 'settings/team', element: <SectionRedirect base="/projects/:projectId/settings" anchor="team" /> },
              { path: 'settings/signal-privacy', element: <SectionRedirect base="/projects/:projectId/settings" anchor="signal-privacy" /> },
              { path: 'settings/workflow', element: <SectionRedirect base="/projects/:projectId/settings" anchor="workflow" /> },
              { path: 'settings/guardrails', element: <SectionRedirect base="/projects/:projectId/settings" anchor="guardrails" /> },
              { path: 'settings/attachments', element: <SectionRedirect base="/projects/:projectId/settings" anchor="attachments" /> },
              { path: 'settings/integrations', element: <SectionRedirect base="/projects/:projectId/settings" anchor="integrations" /> },
              { path: 'settings/notifications', element: <SectionRedirect base="/projects/:projectId/settings" anchor="notifications" /> },
              { path: 'settings/lifecycle', element: <SectionRedirect base="/projects/:projectId/settings" anchor="lifecycle" /> },
              // Pre-0061 alias: /settings/members → Access section.
              { path: 'settings/members', element: <SectionRedirect base="/projects/:projectId/settings" anchor="access" /> },
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
                // Consolidated single scrolling page (ADR-0146, #1248). No Outlet.
                path: 'settings',
                element: (
                  <RequireAdminSettings>
                    <Suspense fallback={<RouteLoadingFallback />}>
                      <ProgramSettingsPage />
                    </Suspense>
                  </RequireAdminSettings>
                ),
              },
              // Legacy per-section redirects — SIBLINGS of `settings` (no Outlet).
              { path: 'settings/general', element: <SectionRedirect base="/programs/:programId/settings" anchor="general" /> },
              { path: 'settings/projects', element: <SectionRedirect base="/programs/:programId/settings" anchor="projects" /> },
              { path: 'settings/access', element: <SectionRedirect base="/programs/:programId/settings" anchor="access" /> },
              { path: 'settings/rollup', element: <SectionRedirect base="/programs/:programId/settings" anchor="rollup" /> },
              { path: 'settings/cadence', element: <SectionRedirect base="/programs/:programId/settings" anchor="cadence" /> },
              { path: 'settings/risk', element: <SectionRedirect base="/programs/:programId/settings" anchor="risk" /> },
              { path: 'settings/attachments', element: <SectionRedirect base="/programs/:programId/settings" anchor="attachments" /> },
              { path: 'settings/integrations', element: <SectionRedirect base="/programs/:programId/settings" anchor="integrations" /> },
              { path: 'settings/lifecycle', element: <SectionRedirect base="/programs/:programId/settings" anchor="lifecycle" /> },
            ],
          },
          // Workspace settings — ONE consolidated scrolling page (ADR-0146, #1248).
          // System Health is a separate multi-route tool area, so it lives on its
          // own shell route below; everything else redirects to an anchor.
          {
            // Consolidated single scrolling page (ADR-0146, #1248). No Outlet.
            path: 'settings',
            element: (
              <RequireAdminSettings>
                <Suspense fallback={<RouteLoadingFallback />}>
                  <WorkspaceSettingsPage />
                </Suspense>
              </RequireAdminSettings>
            ),
          },
          // Legacy per-section redirects — SIBLINGS of `settings` (no Outlet).
          { path: 'settings/general', element: <SectionRedirect base="/settings" anchor="general" /> },
          { path: 'settings/members', element: <SectionRedirect base="/settings" anchor="members" /> },
          { path: 'settings/groups', element: <SectionRedirect base="/settings" anchor="groups" /> },
          { path: 'settings/roles', element: <SectionRedirect base="/settings" anchor="roles" /> },
          { path: 'settings/methodology', element: <SectionRedirect base="/settings" anchor="methodology" /> },
          { path: 'settings/attachments', element: <SectionRedirect base="/settings" anchor="attachments" /> },
          { path: 'settings/email', element: <SectionRedirect base="/settings" anchor="email" /> },
          { path: 'settings/danger', element: <SectionRedirect base="/settings" anchor="danger" /> },
          // OSS-removed Connections routes (ADR-0076) — kept as redirect shims.
          {
            path: 'settings/integrations',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <IntegrationsRedirect />
              </Suspense>
            ),
          },
          {
            path: 'settings/webhooks',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <IntegrationsRedirect />
              </Suspense>
            ),
          },
          // System Health tools — separate multi-route area with its own shell
          // (ADR-0146). Not part of the consolidated scroll page.
          {
            path: 'settings/health',
            element: (
              <RequireAdminSettings>
                <Suspense fallback={<RouteLoadingFallback />}>
                  <WorkspaceSystemHealthShell />
                </Suspense>
              </RequireAdminSettings>
            ),
            children: [
              {
                index: true,
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SystemHealthOverviewPage />
                  </Suspense>
                ),
              },
              {
                path: 'dead-letters',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <DeadLetterInspectorPage />
                  </Suspense>
                ),
              },
              {
                path: 'retention',
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
