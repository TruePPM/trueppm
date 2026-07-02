/**
 * Redirect shim for the removed workspace integration management routes
 * (ADR-0076, #569). The OSS surface for integrations is project-scoped;
 * `/settings/integrations` and `/settings/webhooks-api` are reserved as
 * Enterprise-only slots.
 *
 * Behaviour:
 * - 0 projects → friendly empty state pointing to project creation
 * - 1 project → transparent auto-redirect to that project's integrations tab
 * - 2+ projects → project picker sorted by recently active
 *
 * The Enterprise overlay can register a higher-priority route at the same
 * path via the `routes` slot to replace this shim with the workspace
 * Integration Hub UI (trueppm-enterprise#114).
 */

import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useProjects } from '@/hooks/useProjects';
import { SettingsCard } from '../SettingsShell';

export function IntegrationsRedirect() {
  const { data: projects, isLoading } = useProjects();
  const navigate = useNavigate();

  // Single-project case: transparent redirect, no UI flash. Runs as a side
  // effect after data is loaded so the auto-redirect path stays a one-time
  // event rather than a render-time navigate-during-render side effect
  // (which React Router warns against).
  useEffect(() => {
    if (!projects) return;
    const only = projects.length === 1 ? projects[0] : null;
    if (only) {
      void navigate(`/projects/${only.id}/settings/integrations`, { replace: true });
    }
  }, [projects, navigate]);

  if (isLoading || !projects) {
    return (
      <div className="px-6 py-8">
        <div className="h-4 w-1/3 bg-neutral-surface-sunken rounded-chip motion-safe:animate-pulse" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="px-6 py-8 max-w-2xl">
        <SettingsCard>
          <div className="px-6 py-6">
            <h1 className="text-[18px] font-semibold text-neutral-text-primary mb-2">
              Integrations are configured per project
            </h1>
            <p className="text-[13px] text-neutral-text-secondary mb-5">
              You don&apos;t have any projects yet. Create a project to add
              webhooks, API tokens, and connected accounts.
            </p>
            <Link
              to="/projects/new"
              className="
                inline-flex items-center h-8 px-3 rounded-control text-[13px] font-medium
                bg-brand-primary text-white hover:bg-brand-primary-dark
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              "
            >
              Create your first project
            </Link>
            <p className="mt-5 text-[12px] text-neutral-text-secondary">
              Looking for workspace-wide integration management? That&apos;s
              part of the Enterprise edition.
            </p>
          </div>
        </SettingsCard>
      </div>
    );
  }

  if (projects.length === 1) {
    // Auto-redirect in flight (effect above). Render nothing rather than a
    // flash of the picker UI.
    return null;
  }

  // 2+ projects: render the picker.
  return (
    <div className="px-6 py-6 max-w-2xl">
      <h1 className="text-[18px] font-semibold text-neutral-text-primary mb-1">
        Which project&apos;s integrations?
      </h1>
      <p className="text-[13px] text-neutral-text-secondary mb-5">
        Integrations are configured per project in the OSS edition.
      </p>
      <SettingsCard>
        <ul className="divide-y divide-neutral-border/55">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/projects/${project.id}/settings/integrations`}
                className="
                  flex items-center gap-3 px-4 py-3 min-h-[44px]
                  text-[13px] text-neutral-text-primary
                  hover:bg-neutral-surface-sunken
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                "
              >
                <span
                  aria-hidden="true"
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: project.colorDot }}
                />
                <span className="flex-1 truncate">{project.name}</span>
                <span aria-hidden="true" className="text-neutral-text-secondary">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </SettingsCard>
      <p className="mt-3 text-[12px] text-neutral-text-secondary">
        Tip: bookmark{' '}
        <code className="tppm-mono text-[11px] bg-neutral-surface-sunken rounded-chip px-1.5 py-0.5">
          /projects/&lt;id&gt;/settings/integrations
        </code>{' '}
        to skip this step next time.
      </p>
    </div>
  );
}
