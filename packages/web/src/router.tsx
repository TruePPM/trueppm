import { createBrowserRouter, Navigate, Outlet, useNavigate } from 'react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { lensDefaultView } from '@/features/shell/lensOrder';
import { AppShell } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/project/ProjectShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { RequireAdminSettings } from '@/features/settings/RequireAdminSettings';
import { RequireWorkspaceAdmin } from '@/features/settings/RequireWorkspaceAdmin';
import { SectionRedirect } from '@/features/settings/SectionRedirect';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { RouteTitle } from '@/components/RouteTitle';
import type { RouteHandle } from '@/router/routeHandle';

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
const TodayView = lazy(() =>
  import('@/features/today/TodayView').then((m) => ({ default: m.TodayView })),
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
const ProjectActivityPage = lazy(() =>
  import('@/features/project/activity/ProjectActivityPage').then((m) => ({
    default: m.ProjectActivityPage,
  })),
);
const ProjectAssetsPage = lazy(() =>
  import('@/features/assets/AssetsPage').then((m) => ({ default: m.ProjectAssetsPage })),
);
const ProgramAssetsPage = lazy(() =>
  import('@/features/assets/AssetsPage').then((m) => ({ default: m.ProgramAssetsPage })),
);
const MyAssetsPage = lazy(() =>
  import('@/features/assets/AssetsPage').then((m) => ({ default: m.MyAssetsPage })),
);
const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })),
);
const MyWorkPage = lazy(() =>
  import('@/features/me/MyWorkPage').then((m) => ({ default: m.MyWorkPage })),
);

const TimesheetPage = lazy(() =>
  import('@/features/timesheet/TimesheetPage').then((m) => ({ default: m.TimesheetPage })),
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

const PersonalAccessTokensPage = lazy(() =>
  import('@/features/me/PersonalAccessTokensPage').then((m) => ({
    default: m.PersonalAccessTokensPage,
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
const ProgramSchedulePage = lazy(() =>
  import('@/features/programs/schedule/ProgramSchedulePage').then((m) => ({
    default: m.ProgramSchedulePage,
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
const WorkspaceTrashPage = lazy(() =>
  import('@/features/settings/workspace/WorkspaceTrashPage').then((m) => ({
    default: m.WorkspaceTrashPage,
  })),
);
const InviteAcceptPage = lazy(() =>
  import('@/features/settings/workspace/InviteAcceptPage').then((m) => ({
    default: m.InviteAcceptPage,
  })),
);

// Public read-only board share viewer (#283, ADR-0245) — unauthenticated, lazy so
// it adds nothing to the app bundle for logged-in users.
const PublicBoardSharePage = lazy(() =>
  import('@/features/share/PublicBoardSharePage').then((m) => ({
    default: m.PublicBoardSharePage,
  })),
);

// Public read-only schedule share viewer (#1486, ADR-0265) — unauthenticated sibling
// of the board viewer; lazy so it adds nothing to the logged-in app bundle.
const PublicScheduleSharePage = lazy(() =>
  import('@/features/share/PublicScheduleSharePage').then((m) => ({
    default: m.PublicScheduleSharePage,
  })),
);

// SSO completion landing (#1392, ADR-0187) — public sibling of the login screen;
// lazy so the OIDC flow adds nothing to the initial login bundle.
const SsoCompletePage = lazy(() =>
  import('@/features/auth/SsoCompletePage').then((m) => ({
    default: m.SsoCompletePage,
  })),
);

// ── Self-service password reset (issue 765, ADR-0209) — five public (no-auth) screens.
//    Lazy-loaded so the recovery flow adds nothing to the initial login bundle. ──
const ForgotPasswordPage = lazy(() =>
  import('@/features/auth/passwordReset/ForgotPasswordPage').then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ForgotPasswordSentPage = lazy(() =>
  import('@/features/auth/passwordReset/ForgotPasswordSentPage').then((m) => ({
    default: m.ForgotPasswordSentPage,
  })),
);
const ResetPasswordConfirmPage = lazy(() =>
  import('@/features/auth/passwordReset/ResetPasswordConfirmPage').then((m) => ({
    default: m.ResetPasswordConfirmPage,
  })),
);
const ResetPasswordDonePage = lazy(() =>
  import('@/features/auth/passwordReset/ResetPasswordDonePage').then((m) => ({
    default: m.ResetPasswordDonePage,
  })),
);
const ResetPasswordExpiredPage = lazy(() =>
  import('@/features/auth/passwordReset/ResetPasswordExpiredPage').then((m) => ({
    default: m.ResetPasswordExpiredPage,
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

/**
 * Project-entry redirect (issue 1263, ADR-0162). `/projects/:id` lands on the view the
 * user's role-context lens prefers — PM → Schedule, Scrum Master → Board, Unified
 * → Overview (the historical default). Holds (renders nothing — the ProjectShell
 * chrome stays painted) until `me` resolves, then redirects once, so the user
 * never sees Overview flash before bouncing to their lens's view. On a warm
 * `['current-user']` cache (the common case — TopBar fetched it on shell mount)
 * the redirect is synchronous. The lens is presentation-only: this only changes
 * where you *start*, never what you may access.
 */
function ProjectIndexRedirect() {
  const { user, isLoading } = useCurrentUser();
  if (isLoading || !user) return null;
  return <Navigate to={lensDefaultView(user.role_context)} replace />;
}

/**
 * Root layout mounted above every route, public and authed alike (issue
 * 1915). Hosts `RouteTitle` so `document.title` is set from the deepest
 * matched route's `handle.title` on every navigation — a single router-level
 * mechanism instead of per-page `usePageTitle()` calls.
 */
function RootLayout() {
  return (
    <>
      <RouteTitle />
      <Outlet />
    </>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        path: '/login',
        errorElement: <RouteErrorBoundary />,
        element: <LoginPage />,
        handle: { title: 'Log In' } satisfies RouteHandle,
      },
      // Public route — no auth required. Handles workspace invite token redemption.
      {
        path: '/invite/accept',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <InviteAcceptPage />
          </Suspense>
        ),
        handle: { title: 'Accept Invite' } satisfies RouteHandle,
      },
      // Public routes — no auth required (issue 765, ADR-0209). Self-service password reset:
      // a user who has forgotten their password cannot authenticate, so the whole flow
      // sits outside RequireAuth.
      {
        path: '/forgot-password',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ForgotPasswordPage />
          </Suspense>
        ),
        handle: { title: 'Forgot Password' } satisfies RouteHandle,
      },
      {
        path: '/forgot-password/sent',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ForgotPasswordSentPage />
          </Suspense>
        ),
        handle: { title: 'Reset Link Sent' } satisfies RouteHandle,
      },
      {
        path: '/reset-password/confirm/:uid/:token',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ResetPasswordConfirmPage />
          </Suspense>
        ),
        handle: { title: 'Reset Password' } satisfies RouteHandle,
      },
      {
        path: '/reset-password/done',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ResetPasswordDonePage />
          </Suspense>
        ),
        handle: { title: 'Password Reset' } satisfies RouteHandle,
      },
      {
        path: '/reset-password/expired',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ResetPasswordExpiredPage />
          </Suspense>
        ),
        handle: { title: 'Reset Link Expired' } satisfies RouteHandle,
      },
      // Public route — no auth required (#1392, ADR-0187). SSO completion landing:
      // the OIDC callback 302s here (success mints the session from the refresh
      // cookie; failure arrives as ?error=<code>). Must sit outside RequireAuth so a
      // not-yet-member (sso_no_member) can see the error instead of being bounced.
      {
        path: '/auth/sso/complete',
        errorElement: <RouteErrorBoundary />,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <SsoCompletePage />
          </Suspense>
        ),
        handle: { title: 'Signing You In' } satisfies RouteHandle,
      },
      // Public route — no auth required (#283, ADR-0245). Read-only board share viewer.
      {
        path: '/share/board/:token',
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <PublicBoardSharePage />
          </Suspense>
        ),
        handle: { title: 'Shared Board' } satisfies RouteHandle,
      },
      // Public route — no auth required (#1486, ADR-0265). Read-only schedule share viewer.
      {
        path: '/share/schedule/:token',
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <PublicScheduleSharePage />
          </Suspense>
        ),
        handle: { title: 'Shared Schedule' } satisfies RouteHandle,
      },
      {
        element: <RequireAuth />,
        // Whole-app safety net (issue 1654): any lazy-chunk load failure or render
        // throw in an authed route degrades to the branded RouteErrorBoundary instead
        // of React Router's raw "Unexpected Application Error" screen. The ProjectShell
        // / ProgramShell boundaries below catch closer (keeping the sidebar) first.
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            path: '/',
            element: <AppShell />,
            children: [
              // Project-scoped routes — projectId in path for shareable URLs (ADR-0030)
              {
                path: 'projects/:projectId',
                element: <ProjectShell />,
                // Shell-preserving boundary (issue 1654): a single project view failing
                // (e.g. a stale lazy chunk) is caught here, so AppShell's sidebar stays
                // painted and the user can navigate away rather than losing the whole app.
                errorElement: <RouteErrorBoundary />,
                children: [
                  // /projects/:projectId → lens-aware landing (issue 1263, ADR-0162):
                  // PM→schedule, Scrum Master→board, Unified→today (ADR-0180).
                  { index: true, element: <ProjectIndexRedirect /> },
                  {
                    path: 'overview',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectOverviewPage />
                      </Suspense>
                    ),
                    handle: { title: 'Overview' } satisfies RouteHandle,
                  },
                  {
                    // Unified Today split view (ADR-0180) — the `unified` lens lands here.
                    path: 'today',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <TodayView />
                      </Suspense>
                    ),
                    handle: { title: 'Today' } satisfies RouteHandle,
                  },
                  {
                    path: 'schedule',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ScheduleView />
                      </Suspense>
                    ),
                    handle: { title: 'Schedule' } satisfies RouteHandle,
                  },
                  {
                    path: 'grid',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <GridView />
                      </Suspense>
                    ),
                    handle: { title: 'Grid' } satisfies RouteHandle,
                  },
                  {
                    // Expand-to-full-page focus view of a single task (handoff #13).
                    path: 'tasks/:taskId',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <TaskDetailPage />
                      </Suspense>
                    ),
                    handle: { title: 'Task' } satisfies RouteHandle,
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
                    handle: { title: 'Board' } satisfies RouteHandle,
                  },
                  {
                    path: 'sprints',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <SprintsView />
                      </Suspense>
                    ),
                    handle: { title: 'Sprints' } satisfies RouteHandle,
                  },
                  {
                    // ADR-0105 — Product-Owner backlog / grooming view (#494).
                    path: 'product-backlog',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProductBacklogPage />
                      </Suspense>
                    ),
                    handle: { title: 'Product Backlog' } satisfies RouteHandle,
                  },
                  {
                    path: 'calendar',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <CalendarView />
                      </Suspense>
                    ),
                    handle: { title: 'Calendar' } satisfies RouteHandle,
                  },
                  {
                    path: 'resources',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <TeamView />
                      </Suspense>
                    ),
                    handle: { title: 'Team' } satisfies RouteHandle,
                    children: [
                      { index: true, element: <Navigate to="roster" replace /> },
                      {
                        path: 'roster',
                        element: <RosterPage />,
                        handle: { title: 'Roster' } satisfies RouteHandle,
                      },
                      {
                        path: 'allocation',
                        element: <ResourceView />,
                        handle: { title: 'Resources' } satisfies RouteHandle,
                      },
                      {
                        path: 'heatmap',
                        element: <HeatmapPage />,
                        handle: { title: 'Heatmap' } satisfies RouteHandle,
                      },
                    ],
                  },
                  {
                    path: 'risk',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <RiskRegisterView />
                      </Suspense>
                    ),
                    handle: { title: 'Risk Register' } satisfies RouteHandle,
                  },
                  {
                    path: 'reports',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ReportsView />
                      </Suspense>
                    ),
                    handle: { title: 'Reports' } satisfies RouteHandle,
                  },
                  {
                    path: 'activity',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectActivityPage />
                      </Suspense>
                    ),
                    handle: { title: 'Activity' } satisfies RouteHandle,
                  },
                  {
                    // Unified Assets surface — task files + external links (ADR-0215, issue 971).
                    path: 'assets',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProjectAssetsPage />
                      </Suspense>
                    ),
                    handle: { title: 'Assets' } satisfies RouteHandle,
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
                    handle: { title: 'Project Settings' } satisfies RouteHandle,
                  },
                  // Legacy per-section paths (pre-0146) redirect to the consolidated
                  // page at the matching anchor so bookmarks, emails, and old e2e
                  // specs keep working. SIBLINGS of `settings` — the consolidated
                  // page renders no Outlet, so these can't be nested under it.
                  {
                    path: 'settings/general',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="general" />
                    ),
                  },
                  {
                    path: 'settings/access',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="access" />
                    ),
                  },
                  {
                    path: 'settings/methodology',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="methodology" />
                    ),
                  },
                  {
                    path: 'settings/team',
                    element: <SectionRedirect base="/projects/:projectId/settings" anchor="team" />,
                  },
                  {
                    path: 'settings/signal-privacy',
                    element: (
                      <SectionRedirect
                        base="/projects/:projectId/settings"
                        anchor="signal-privacy"
                      />
                    ),
                  },
                  {
                    path: 'settings/workflow',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="workflow" />
                    ),
                  },
                  {
                    path: 'settings/calendars',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="calendars" />
                    ),
                  },
                  {
                    path: 'settings/guardrails',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="guardrails" />
                    ),
                  },
                  {
                    path: 'settings/attachments',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="attachments" />
                    ),
                  },
                  {
                    path: 'settings/surfaces',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="surfaces" />
                    ),
                  },
                  {
                    path: 'settings/integrations',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="integrations" />
                    ),
                  },
                  {
                    path: 'settings/notifications',
                    element: (
                      <SectionRedirect
                        base="/projects/:projectId/settings"
                        anchor="notifications"
                      />
                    ),
                  },
                  {
                    path: 'settings/lifecycle',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="lifecycle" />
                    ),
                  },
                  // Pre-0061 alias: /settings/members → Access section.
                  {
                    path: 'settings/members',
                    element: (
                      <SectionRedirect base="/projects/:projectId/settings" anchor="access" />
                    ),
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
                handle: { title: 'Resource Catalog' } satisfies RouteHandle,
              },
              // My Work — cross-project contributor surface (#499, ADR-0065 Gap 2)
              {
                path: 'me/work',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <MyWorkPage />
                  </Suspense>
                ),
                handle: { title: 'My Work' } satisfies RouteHandle,
              },
              // My Assets — personal cross-project files + links (#1980, ADR-0428).
              {
                path: 'me/assets',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <MyAssetsPage />
                  </Suspense>
                ),
                handle: { title: 'My Assets' } satisfies RouteHandle,
              },
              // Timesheet — weekly cross-project entry + submit (#1435, ADR-0224).
              {
                path: 'me/timesheet',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TimesheetPage />
                  </Suspense>
                ),
                handle: { title: 'Timesheet' } satisfies RouteHandle,
              },
              // Notification inbox — mobile-primary, desktop secondary (#311 phase 3).
              {
                path: 'me/notifications',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <NotificationListPage />
                  </Suspense>
                ),
                handle: { title: 'Notifications' } satisfies RouteHandle,
              },
              // Bare /me/settings has no page of its own — a typed URL or bookmark
              // used to fall through to the `*` 404. Redirect it to General (#2023).
              {
                path: 'me/settings',
                element: <Navigate to="/me/settings/general" replace />,
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
                handle: { title: 'My Preferences' } satisfies RouteHandle,
              },
              // Per-user notification preference matrix (#311 phase 4).
              {
                path: 'me/settings/notifications',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <NotificationPreferencesPage />
                  </Suspense>
                ),
                handle: { title: 'Notification Preferences' } satisfies RouteHandle,
              },
              // Per-user IntegrationCredential listing (#587, ADR-0049 §3).
              {
                path: 'me/settings/connected-accounts',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ConnectedAccountsPage />
                  </Suspense>
                ),
                handle: { title: 'Connected Accounts' } satisfies RouteHandle,
              },
              // Per-user Personal Access Tokens (issue 648, ADR-0214).
              {
                path: 'me/settings/api-tokens',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <PersonalAccessTokensPage />
                  </Suspense>
                ),
                handle: { title: 'Personal Access Tokens' } satisfies RouteHandle,
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
                handle: { title: 'Programs' } satisfies RouteHandle,
              },
              {
                path: 'programs/:programId',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProgramShell />
                  </Suspense>
                ),
                // Shell-preserving boundary (issue 1654) — see the ProjectShell note.
                errorElement: <RouteErrorBoundary />,
                children: [
                  { index: true, element: <Navigate to="overview" replace /> },
                  {
                    path: 'overview',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramOverviewPage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Overview' } satisfies RouteHandle,
                  },
                  {
                    path: 'backlog',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramBacklogPage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Backlog' } satisfies RouteHandle,
                  },
                  {
                    path: 'projects',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramViewProjectsPage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Projects' } satisfies RouteHandle,
                  },
                  {
                    path: 'schedule',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramSchedulePage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Schedule' } satisfies RouteHandle,
                  },
                  {
                    path: 'resources',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramResourcesPage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Resources' } satisfies RouteHandle,
                  },
                  {
                    path: 'members',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramMembersTab />
                      </Suspense>
                    ),
                    handle: { title: 'Program Members' } satisfies RouteHandle,
                  },
                  {
                    // Unified Assets surface across the program's readable member
                    // projects — files + external links (ADR-0215, issue 971).
                    path: 'assets',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <ProgramAssetsPage />
                      </Suspense>
                    ),
                    handle: { title: 'Program Assets' } satisfies RouteHandle,
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
                    handle: { title: 'Program Settings' } satisfies RouteHandle,
                  },
                  // Legacy per-section redirects — SIBLINGS of `settings` (no Outlet).
                  {
                    path: 'settings/general',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="general" />
                    ),
                  },
                  {
                    path: 'settings/projects',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="projects" />
                    ),
                  },
                  {
                    path: 'settings/access',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="access" />
                    ),
                  },
                  {
                    path: 'settings/stakeholders',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="stakeholders" />
                    ),
                  },
                  {
                    path: 'settings/rollup',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="rollup" />
                    ),
                  },
                  {
                    path: 'settings/cadence',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="cadence" />
                    ),
                  },
                  {
                    path: 'settings/calendar',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="calendar" />
                    ),
                  },
                  {
                    path: 'settings/risk',
                    element: <SectionRedirect base="/programs/:programId/settings" anchor="risk" />,
                  },
                  {
                    path: 'settings/attachments',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="attachments" />
                    ),
                  },
                  {
                    path: 'settings/integrations',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="integrations" />
                    ),
                  },
                  {
                    path: 'settings/lifecycle',
                    element: (
                      <SectionRedirect base="/programs/:programId/settings" anchor="lifecycle" />
                    ),
                  },
                ],
              },
              // Workspace settings — ONE consolidated scrolling page (ADR-0146, #1248).
              // System Health is a separate multi-route tool area, so it lives on its
              // own shell route below; everything else redirects to an anchor.
              {
                // Consolidated single scrolling page (ADR-0146, #1248). No Outlet.
                // Workspace-admin-gated specifically (#2012): every write here is
                // `IsWorkspaceAdmin`, so a project-admin who is a plain workspace
                // member is bounced rather than shown enabled-but-403 controls.
                path: 'settings',
                element: (
                  <RequireWorkspaceAdmin>
                    <Suspense fallback={<RouteLoadingFallback />}>
                      <WorkspaceSettingsPage />
                    </Suspense>
                  </RequireWorkspaceAdmin>
                ),
                handle: { title: 'Workspace Settings' } satisfies RouteHandle,
              },
              // Legacy per-section redirects — SIBLINGS of `settings` (no Outlet).
              {
                path: 'settings/general',
                element: <SectionRedirect base="/settings" anchor="general" />,
              },
              {
                path: 'settings/members',
                element: <SectionRedirect base="/settings" anchor="members" />,
              },
              {
                path: 'settings/groups',
                element: <SectionRedirect base="/settings" anchor="groups" />,
              },
              {
                path: 'settings/roles',
                element: <SectionRedirect base="/settings" anchor="roles" />,
              },
              { path: 'settings/sso', element: <SectionRedirect base="/settings" anchor="sso" /> },
              {
                path: 'settings/methodology',
                element: <SectionRedirect base="/settings" anchor="methodology" />,
              },
              {
                path: 'settings/schedule',
                element: <SectionRedirect base="/settings" anchor="schedule" />,
              },
              {
                path: 'settings/calendar',
                element: <SectionRedirect base="/settings" anchor="calendar" />,
              },
              {
                path: 'settings/programs',
                element: <SectionRedirect base="/settings" anchor="programs" />,
              },
              {
                path: 'settings/attachments',
                element: <SectionRedirect base="/settings" anchor="attachments" />,
              },
              {
                path: 'settings/email',
                element: <SectionRedirect base="/settings" anchor="email" />,
              },
              {
                path: 'settings/danger',
                element: <SectionRedirect base="/settings" anchor="danger" />,
              },
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
              // Trash (issue 1113, ADR-0202) — recoverable soft-deleted projects. Renders its
              // own SettingsShell (like the System Health area). Any member may view; the
              // per-row Restore is Owner-gated by the API.
              {
                path: 'settings/trash',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WorkspaceTrashPage />
                  </Suspense>
                ),
                handle: { title: 'Trash' } satisfies RouteHandle,
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
                    handle: { title: 'System Health' } satisfies RouteHandle,
                  },
                  {
                    path: 'dead-letters',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <DeadLetterInspectorPage />
                      </Suspense>
                    ),
                    handle: { title: 'Dead Letter Queue' } satisfies RouteHandle,
                  },
                  {
                    path: 'retention',
                    element: (
                      <Suspense fallback={<RouteLoadingFallback />}>
                        <RetentionPurgePage />
                      </Suspense>
                    ),
                    handle: { title: 'Retention & Purge' } satisfies RouteHandle,
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
        handle: { title: 'Page Not Found' } satisfies RouteHandle,
      },
    ],
  },
]);
