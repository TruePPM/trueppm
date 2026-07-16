/**
 * Project → Settings → Integrations — webhook + API-token management (#638 / #600).
 *
 * Full CRUD via WebhooksManager + ApiTokensManager (each fetches its own list
 * and owns its loading/empty/error states). Replaces the read-only 0.2 summary
 * cards. Per-user credentials (IntegrationCredential, #302) live under User →
 * Connected Accounts and are surfaced via the teaser below.
 */

import { useProjectId } from '@/hooks/useProjectId';
import type { IntegrationScope } from '@/hooks/useWebhooks';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { registry } from '@/lib/widget-registry';
import { WebhooksManager } from '../components/integrations/WebhooksManager';
import { ApiTokensManager } from '../components/integrations/ApiTokensManager';
import { GitAutomationManager } from '../components/integrations/GitAutomationManager';
import { ConnectorRoadmapCard } from '../ConnectorRoadmapCard';

export function ProjectIntegrationsPage() {
  const projectId = useProjectId();
  if (!projectId) return null;

  const scope: IntegrationScope = { kind: 'project', id: projectId };
  const enterpriseSlots = registry.get('project_settings.integrations');

  return (
    <div>
      <SettingsPageTitle
        title="Integrations"
        subtitle="How this project connects to your stack. Per-user credentials live under User → Connected Accounts."
      />

      <div className="px-6 pb-8 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <WebhooksManager scope={scope} />
          <ApiTokensManager scope={scope} />
        </div>

        {/* Git-event board automation is project-scoped only (issue 1257 / issue 329); the
            section hides itself below the project-admin role. */}
        <GitAutomationManager projectId={projectId} />

        <ConnectedAccountsTeaser />

        <ConnectorRoadmapCard />

        {enterpriseSlots.length > 0 && (
          <div className="space-y-4" data-testid="enterprise-integration-slot">
            {enterpriseSlots.map((reg) => {
              const Comp = reg.component;
              return <Comp key={reg.id} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectedAccountsTeaser() {
  return (
    <SettingsCard className="bg-neutral-surface-sunken">
      <div className="px-4 py-3.5">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary mb-1">
          Your connected accounts
        </h2>
        <p className="text-[13px] text-neutral-text-secondary">
          Connect GitLab or GitHub to enable on-demand previews of task links.
          Credentials are per-user and stored encrypted.{' '}
          <a
            href="/me/settings/connected-accounts"
            className="text-brand-primary underline-offset-2 hover:underline"
          >
            Manage credentials →
          </a>
        </p>
      </div>
    </SettingsCard>
  );
}
