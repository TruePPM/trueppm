/**
 * Empty states for /me/work (v2 warm refresh, ADR-0129).
 *
 * Three flavors, all `role="status"`:
 *   - Flavor A — user has no project memberships at all (brand-new). Warm
 *     welcome + an "Explore a demo project" primary CTA (load-sample, reused
 *     across the app) plus a "Learn more" docs link, so a first-time user has an
 *     obvious next step.
 *   - Flavor B — user has projects but no assignments. Same typographic refresh,
 *     no demo CTA (they're not new, just unassigned).
 *   - Offline — when the browser is offline we can't know whether the user has
 *     projects, so we don't claim "you have no projects": calm "you're offline"
 *     copy with the demo CTA disabled.
 *
 * v2 design (ADR-0126): a line icon (navy stroke, aria-hidden) replaces the
 * emoji; borders over shadows; color is signal-only.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/Button';
import { InboxIcon } from '@/components/Icons';
import { docsUrl } from '@/lib/docsUrl';
import { useLoadSampleProgram } from '@/hooks/useProgramSeedIo';
import { NewProjectModal } from '@/features/shell/NewProjectModal';

interface Props {
  hasProjects: boolean;
  /**
   * Whether the user has any connected external source (Jira etc.). When false,
   * the "no assignments" state offers a Connect-Jira nudge so a contributor who
   * lives in Jira has a next step (#1422).
   */
  hasConnectedExternalSource?: boolean;
}

const CONNECTED_ACCOUNTS_ROUTE = '/me/settings/connected-accounts';

/** "Connect Jira" nudge — one step for a contributor whose work lives in Jira. */
function ConnectJiraNudge() {
  return (
    <Link
      to={CONNECTED_ACCOUNTS_ROUTE}
      className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 rounded-control"
    >
      Connect Jira to see your assigned issues here →
    </Link>
  );
}

/** "Browse programs" link — a next step for an evaluator who wants to look
 *  around before creating anything (#2034). */
function BrowseProgramsLink() {
  return (
    <Link
      to="/programs"
      className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 rounded-control"
    >
      Browse programs →
    </Link>
  );
}

/** Shared "Learn more" docs link, refreshed (no emoji). */
function LearnMoreLink() {
  return (
    <a
      href={docsUrl('features/my-work')}
      className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 rounded-control"
    >
      Learn more →
    </a>
  );
}

/** "Explore a demo project" CTA — loads the bundled sample, then navigates to it. */
function ExploreDemoButton({
  disabled,
  variant = 'primary',
}: {
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const navigate = useNavigate();
  const loadSample = useLoadSampleProgram();
  const [failed, setFailed] = useState(false);

  function explore() {
    setFailed(false);
    loadSample.mutate(undefined, {
      onSuccess: (result) => {
        // Land a contributor on the board holding their freshly-assigned open
        // sprint (so My Work-style work is immediately visible), not the PM-facing
        // Program Overview. Fall back to overview when the sample has no open
        // sprint. Carry the sample key so the "Start exploring" callout renders.
        const dest = result.landing_project_id
          ? `/projects/${result.landing_project_id}/board`
          : `/programs/${result.program.id}/overview`;
        void navigate(dest, { state: { startExploringSample: result.sample_key } });
      },
      onError: () => setFailed(true),
    });
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        variant={variant}
        size="lg"
        onClick={explore}
        disabled={disabled === true || loadSample.isPending}
        title={disabled === true ? "You're offline — reconnect to load the demo" : undefined}
      >
        {loadSample.isPending ? 'Loading demo…' : 'Explore a demo project'}
      </Button>
      {failed && (
        <p role="alert" className="text-xs text-semantic-critical">
          Couldn&rsquo;t load the demo — please try again.
        </p>
      )}
    </div>
  );
}

export function MyWorkEmptyState({ hasProjects, hasConnectedExternalSource = false }: Props) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const showConnectJira = !hasConnectedExternalSource;
  const navigate = useNavigate();
  const [showNewProject, setShowNewProject] = useState(false);

  if (offline) {
    return (
      <div
        role="status"
        className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
      >
        <InboxIcon aria-hidden="true" className="h-10 w-10 text-navy-700 dark:text-reversed" />
        <h2 className="text-base font-medium text-neutral-text-primary">You&rsquo;re offline</h2>
        <p className="max-w-md text-sm text-neutral-text-secondary">
          You&rsquo;re offline. Your work will appear here once you reconnect.
        </p>
        <ExploreDemoButton disabled />
        <LearnMoreLink />
      </div>
    );
  }

  if (!hasProjects) {
    return (
      <div
        role="status"
        className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
      >
        <InboxIcon aria-hidden="true" className="h-10 w-10 text-navy-700 dark:text-reversed" />
        <h2 className="text-base font-medium text-neutral-text-primary">
          Welcome to TruePPM — let&rsquo;s get you started
        </h2>
        <p className="max-w-md text-sm text-neutral-text-secondary">
          This is My Work — your home for everything assigned to you across projects. Create your
          first project to start planning, or spin up a demo to see how it all fits together.
        </p>
        {/* Highest-intent evaluators are here to do real work — lead with create,
            keep the demo as the low-commitment secondary path (#2034). */}
        <Button variant="primary" size="lg" onClick={() => setShowNewProject(true)}>
          Create your first project
        </Button>
        <ExploreDemoButton variant="secondary" />
        <div className="flex items-center gap-4">
          <BrowseProgramsLink />
          <LearnMoreLink />
        </div>
        {showNewProject && (
          <NewProjectModal
            onClose={() => setShowNewProject(false)}
            onCreated={(projectId) => {
              setShowNewProject(false);
              void navigate(`/projects/${projectId}/overview`);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
    >
      <InboxIcon aria-hidden="true" className="h-10 w-10 text-navy-700 dark:text-reversed" />
      <h2 className="text-base font-medium text-neutral-text-primary">
        You&rsquo;re all caught up
      </h2>
      <p className="max-w-md text-sm text-neutral-text-secondary">
        Nothing is assigned to you right now. When a teammate assigns you a task — or you create one
        — it&rsquo;ll show up here.
      </p>
      {showConnectJira && <ConnectJiraNudge />}
      <LearnMoreLink />
    </div>
  );
}
