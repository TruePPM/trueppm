import axios from 'axios';
import { SettingsShell, SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { buildWorkspaceNavGroups } from './workspaceNav';
import { TelemetryCard } from './systemHealth/TelemetryCard';

/**
 * Workspace > Observability (#2250).
 *
 * Dedicated home for OTLP telemetry export setup, promoted out of the bottom of
 * the System Health monitoring readout into its own settings rail entry so a
 * self-hosting operator can find it by name (recognition over recall). System
 * Health keeps a one-line export-status readout that cross-links here; this page
 * owns the guided setup, config summary, and test-export verification.
 *
 * Like the other workspace-only tool pages (System Health, Trash), it renders the
 * shared rail off-route (`linked: true` — config sections deep-link back to the
 * consolidated page) and HIDES the program/project scope segments, since telemetry
 * export is inherently a workspace-level concern (#2251).
 */

// Off-route shell → config sections deep-link to the consolidated page anchor.
// Fed from the shared builder so the rail cannot drift (#2013).
const NAV_GROUPS = buildWorkspaceNavGroups({ linked: true });

/**
 * Observability content (title + telemetry card) with NO shell wrapper, so it
 * renders both as its own routed page and as an inline `<SettingsSection>` on the
 * consolidated `/settings` page (#2298). Telemetry posture is static env/Helm
 * config, so this reads `useSystemHealth({ poll: false })` — one fetch, no poll —
 * and shares that query with the System-health landing card on the same page.
 */
export function ObservabilitySection() {
  const { data, isLoading, error, refetch } = useSystemHealth({ poll: false });

  const is403 = error !== null && axios.isAxiosError(error) && error.response?.status === 403;

  return (
    <>
      <SettingsPageTitle
        title="Observability"
        subtitle="Export TruePPM traces and metrics to your OpenTelemetry backend (OTLP)."
      />

      <div className="max-w-[860px] px-4 pb-8 sm:px-6 pt-4">
        {isLoading ? (
          <div className="h-[220px] animate-pulse rounded-card border border-neutral-border bg-neutral-surface-sunken" />
        ) : error !== null && data === undefined ? (
          <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-[13px] text-neutral-text-secondary">
              {is403
                ? "You don't have permission to view telemetry settings."
                : "Couldn't load telemetry status."}
            </p>
            {!is403 && (
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-3 rounded-control border border-neutral-border px-3 py-1.5 text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <TelemetryCard telemetry={data!.telemetry} />
        )}
      </div>
    </>
  );
}

export function WorkspaceObservabilityPage() {
  const { data: ws } = useWorkspaceSettings();

  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        // Telemetry export is workspace-level — hide the inapplicable scopes (#2251).
        { scope: 'program', label: 'Program', to: null, hidden: true },
        { scope: 'project', label: 'Project', to: null, hidden: true },
      ]}
      contextName={ws?.name ?? 'Workspace'}
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <ObservabilitySection />
    </SettingsShell>
  );
}
