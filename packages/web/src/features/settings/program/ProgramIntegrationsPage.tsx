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
import { SettingsPageTitle, DocsLink } from '../SettingsShell';
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
        {/* Parity with the project Integrations page (#2487): the two surfaces mount
            the same managers, and the project page has carried this reference row
            since #2266 while this one had no docs path at all. Page-owned rather
            than a ⓘ inside each manager header, because WebhooksManager and
            ApiTokensManager are shared across all three scopes — editing their
            headers would change every scope at once. Link text deliberately avoids
            the manager-header phrases "Outbound webhooks" / "Inbound API tokens",
            which the integrations e2e locates with a case-insensitive substring
            getByText that would otherwise trip a strict-mode collision. */}
        <p className="text-[12px] text-neutral-text-secondary leading-relaxed">
          New to integrations? See the docs on{' '}
          <DocsLink href="features/webhooks">webhooks</DocsLink>,{' '}
          <DocsLink href="features/personal-access-tokens">API tokens</DocsLink>, and{' '}
          <DocsLink href="administration/git-event-automation">Git-event automation</DocsLink>.
        </p>

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
