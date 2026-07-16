/**
 * Program → Settings → Integrations — program-scoped webhook + API-token
 * management (#638 / #600, ADR-0076 extension).
 *
 * A program-scoped webhook fires for events on ANY project in the program, and
 * a program-scoped token authorizes inbound writes into any of them — configure
 * once instead of pasting the same Slack URL into N project settings pages.
 * Same managers as the project page, scoped to the program.
 */

import { useParams } from 'react-router';
import type { IntegrationScope } from '@/hooks/useWebhooks';
import { SettingsPageTitle } from '../SettingsShell';
import { registry } from '@/lib/widget-registry';
import { WebhooksManager } from '../components/integrations/WebhooksManager';
import { ApiTokensManager } from '../components/integrations/ApiTokensManager';
import { ConnectorRoadmapCard } from '../ConnectorRoadmapCard';

export function ProgramIntegrationsPage() {
  const { programId } = useParams<{ programId: string }>();
  if (!programId) return null;

  const scope: IntegrationScope = { kind: 'program', id: programId };
  const enterpriseSlots = registry.get('project_settings.integrations');

  return (
    <div>
      <SettingsPageTitle
        title="Integrations"
        subtitle="Program-wide webhooks and tokens fire across every project in this program. Project-scoped integrations live under each project's settings."
      />

      <div className="px-6 pb-8 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <WebhooksManager scope={scope} />
          <ApiTokensManager scope={scope} />
        </div>

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
