/**
 * Project → Settings → Integrations — read-only summary page (ADR-0076, #569).
 *
 * Surfaces the project's outbound webhooks (ADR-0019) and inbound API tokens
 * (ADR-0068) in one place. CRUD is delegated to the underlying dedicated
 * pages via deep-links; this page is intentionally read-only in 0.2 (per
 * ADR-0076 open question 1).
 *
 * The credentials section (per-user IntegrationCredential from ADR-0049) is
 * intentionally absent in 0.2 — its backend ships with #302. The "Manage
 * connected accounts" deep-link is provided by the User → Settings →
 * Connected Accounts page filed under #587.
 */

import { useProjectId } from '@/hooks/useProjectId';
import {
  useProjectIntegrationsSummary,
  type WebhookSummaryItem,
  type ApiTokenSummaryItem,
} from '@/hooks/useProjectIntegrationsSummary';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { registry } from '@/lib/widget-registry';

export function ProjectIntegrationsPage() {
  const projectId = useProjectId();
  const { summary, isLoading, failedSection, refetch } =
    useProjectIntegrationsSummary(projectId);

  if (!projectId) return null;

  const webhooks = summary?.webhooks;
  const apiTokens = summary?.api_tokens;

  // Page-level empty state: zero items across both project-scoped sections.
  // Per ux-design, distinct from per-section empty.
  const pageEmpty =
    !isLoading &&
    summary &&
    (webhooks?.items.length ?? 0) === 0 &&
    (apiTokens?.items.length ?? 0) === 0;

  const enterpriseSlots = registry.get('project_settings.integrations');

  return (
    <div>
      <SettingsPageTitle
        title="Integrations"
        subtitle="How this project connects to your stack. Per-user credentials live under User → Connected Accounts."
        action={
          <button
            type="button"
            onClick={() => { void refetch(); }}
            disabled={isLoading}
            className="
              h-7 px-3 text-xs font-medium
              border border-neutral-border rounded
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-50
            "
            aria-label="Refresh integrations summary"
          >
            Refresh
          </button>
        }
      />

      <div className="px-6 py-5 space-y-6">
        {pageEmpty ? (
          <PageEmptyState />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <WebhooksCard
                isLoading={isLoading}
                webhooks={webhooks}
                failed={failedSection === 'webhooks'}
                onRetry={refetch}
              />
              <ApiTokensCard
                isLoading={isLoading}
                apiTokens={apiTokens}
                failed={failedSection === 'api_tokens'}
                onRetry={refetch}
              />
            </div>

            <ConnectedAccountsTeaser />

            {enterpriseSlots.length > 0 && (
              <div className="space-y-4" data-testid="enterprise-integration-slot">
                {enterpriseSlots.map((reg) => {
                  const Comp = reg.component;
                  return <Comp key={reg.id} />;
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Webhooks
// ---------------------------------------------------------------------------

interface WebhooksCardProps {
  isLoading: boolean;
  webhooks: {
    items: WebhookSummaryItem[];
    total: number;
    active_total: number;
    last_delivery_at: string | null;
  } | undefined;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}

function WebhooksCard({ isLoading, webhooks, failed, onRetry }: WebhooksCardProps) {
  if (failed) {
    return <SectionErrorCard title="Outbound webhooks" onRetry={onRetry} />;
  }
  if (isLoading || !webhooks) {
    return <SectionSkeleton title="Outbound webhooks" />;
  }

  const empty = webhooks.total === 0;
  const statusDot = computeWebhookStatusDot(webhooks.items);

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">Outbound webhooks</h2>
          <span className="text-[12px] text-neutral-text-secondary tppm-mono" aria-label={`${webhooks.total} webhooks`}>
            {webhooks.total}
          </span>
          {statusDot && (
            <span
              aria-hidden="true"
              className={`inline-block w-2 h-2 rounded-full ml-1 ${statusDot.className}`}
              title={statusDot.title}
            />
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        {empty ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No webhooks configured. Add one to push events to Slack, Discord, or any HTTP endpoint.
          </p>
        ) : (
          <ul className="space-y-2">
            {webhooks.items.map((wh) => (
              <li key={wh.id} className="flex items-baseline gap-2 min-w-0">
                <WebhookStatusDot delivery={wh.last_delivery} active={wh.is_active} />
                <span
                  className="text-[13px] text-neutral-text-primary truncate min-w-0 flex-1"
                  title={wh.url}
                >
                  {wh.url}
                </span>
                <span className="text-[12px] text-neutral-text-secondary tppm-mono shrink-0">
                  {formatRelative(wh.last_delivery?.created_at ?? wh.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 pb-3.5 pt-1 flex items-center gap-3">
        {/* Dedicated project-scoped Webhook CRUD page is a follow-up; ADR-0076
            open question 1 deferred CRUD-inline to 0.3. Until that page lands,
            mutations go through the API directly. */}
        <span
          className="text-[12px] text-neutral-text-secondary"
          title="Project-scoped webhook CRUD UI lands in 0.3; until then, use the API."
        >
          Manage via API (UI coming in 0.3)
        </span>
      </div>
    </SettingsCard>
  );
}

function WebhookStatusDot({
  delivery,
  active,
}: {
  delivery: WebhookSummaryItem['last_delivery'];
  active: boolean;
}) {
  let cls = 'bg-neutral-text-disabled';
  let label = 'No deliveries yet';
  if (!active) {
    cls = 'bg-neutral-text-disabled';
    label = 'Inactive';
  } else if (delivery?.status === 'success') {
    cls = 'bg-semantic-on-track';
    label = 'Last delivery succeeded';
  } else if (delivery?.status === 'failed') {
    cls = 'bg-semantic-critical';
    label = 'Last delivery failed';
  } else if (delivery?.status === 'pending') {
    cls = 'bg-semantic-at-risk';
    label = 'Delivery pending';
  }
  return (
    <span
      aria-label={label}
      className={`inline-block w-2 h-2 rounded-full mt-1 shrink-0 ${cls}`}
    />
  );
}

function computeWebhookStatusDot(
  items: WebhookSummaryItem[],
): { className: string; title: string } | null {
  if (items.length === 0) return null;
  const hasRecentFailure = items.some((wh) => wh.recent_failure_count > 0);
  const hasOldFailure = items.some(
    (wh) => wh.last_delivery?.status === 'failed' && wh.recent_failure_count === 0,
  );
  if (hasRecentFailure) {
    return {
      className: 'bg-semantic-at-risk',
      title: 'One or more webhooks failed in the last 7 days',
    };
  }
  if (hasOldFailure) {
    return { className: 'bg-semantic-critical', title: 'One or more webhooks last failed' };
  }
  return { className: 'bg-semantic-on-track', title: 'All webhooks healthy' };
}

// ---------------------------------------------------------------------------
// Section: API Tokens
// ---------------------------------------------------------------------------

interface ApiTokensCardProps {
  isLoading: boolean;
  apiTokens: {
    items: ApiTokenSummaryItem[];
    active_total: number;
    last_used_at: string | null;
  } | undefined;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}

function ApiTokensCard({ isLoading, apiTokens, failed, onRetry }: ApiTokensCardProps) {
  if (failed) {
    return <SectionErrorCard title="Inbound API tokens" onRetry={onRetry} />;
  }
  if (isLoading || !apiTokens) {
    return <SectionSkeleton title="Inbound API tokens" />;
  }

  const empty = apiTokens.active_total === 0;

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">Inbound API tokens</h2>
          <span className="text-[12px] text-neutral-text-secondary tppm-mono" aria-label={`${apiTokens.active_total} active tokens`}>
            {apiTokens.active_total}
          </span>
        </div>
      </div>

      <div className="px-4 py-3">
        {empty ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No inbound tokens. Generate one to let CI or external tools push tasks into this project.
          </p>
        ) : (
          <ul className="space-y-2">
            {apiTokens.items.map((tok) => (
              <li key={tok.id} className="flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] text-neutral-text-primary truncate min-w-0 flex-1">{tok.name}</span>
                <span className="text-[12px] text-neutral-text-secondary tppm-mono shrink-0">
                  {tok.token_prefix}…
                </span>
                <span className="text-[12px] text-neutral-text-secondary tppm-mono shrink-0">
                  {tok.last_used_at ? `used ${formatRelative(tok.last_used_at)}` : 'never used'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 pb-3.5 pt-1 flex items-center gap-3">
        {/* See note in WebhooksCard — project-scoped API Token CRUD UI lands
            in 0.3 per ADR-0076 open question 1. */}
        <span
          className="text-[12px] text-neutral-text-secondary"
          title="Project-scoped API Token CRUD UI lands in 0.3; until then, use the API."
        >
          Manage via API (UI coming in 0.3)
        </span>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Connected accounts teaser — full UI ships with #302 / #587 (User → Connected Accounts)
// ---------------------------------------------------------------------------

function ConnectedAccountsTeaser() {
  return (
    <SettingsCard className="bg-neutral-surface-sunken">
      <div className="px-4 py-3.5">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary mb-1">
          Your connected accounts
        </h2>
        <p className="text-[13px] text-neutral-text-secondary">
          Connect GitLab or GitHub to enable on-demand previews of task links.
          Connected accounts ship with the OSS extension-point work in progress
          (issue #302) — manage your accounts from User → Settings → Connected
          Accounts when available.
        </p>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Page-level empty state
// ---------------------------------------------------------------------------

function PageEmptyState() {
  return (
    <SettingsCard>
      <div className="px-6 py-8">
        <h2 className="text-[15px] font-semibold text-neutral-text-primary mb-2">
          No integrations yet
        </h2>
        <p className="text-[13px] text-neutral-text-secondary mb-4">
          This project doesn&apos;t have any webhooks, inbound tokens, or
          connected accounts yet.
        </p>
        <ul className="space-y-3 text-[13px]">
          <li className="text-neutral-text-secondary">
            <span className="font-medium text-neutral-text-primary">Add a webhook</span>
            {' '}— push events to Slack, Discord, or any HTTP endpoint
            <span className="block text-[12px] mt-0.5">Use the API today; CRUD UI lands in 0.3.</span>
          </li>
          <li className="text-neutral-text-secondary">
            <span className="font-medium text-neutral-text-primary">Generate an API token</span>
            {' '}— let CI or external tools push tasks in
            <span className="block text-[12px] mt-0.5">Use the API today; CRUD UI lands in 0.3.</span>
          </li>
          <li className="text-neutral-text-secondary">
            <span className="font-medium text-neutral-text-primary">Connect your accounts</span>
            {' '}— ships with the OSS extension-point work in progress (#302)
          </li>
        </ul>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Section primitives: skeleton + error
// ---------------------------------------------------------------------------

function SectionSkeleton({ title }: { title: string }) {
  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 border-b border-neutral-border/55">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary">{title}</h2>
      </div>
      <div className="px-4 py-3 space-y-2" aria-busy="true" aria-label={`Loading ${title}`}>
        <div className="h-3 w-3/4 bg-neutral-surface-sunken rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-neutral-surface-sunken rounded animate-pulse" />
        <div className="h-3 w-2/3 bg-neutral-surface-sunken rounded animate-pulse" />
      </div>
    </SettingsCard>
  );
}

function SectionErrorCard({
  title,
  onRetry,
}: {
  title: string;
  onRetry: () => Promise<unknown>;
}) {
  return (
    <SettingsCard className="border-semantic-critical/40">
      <div className="px-4 pt-3.5 pb-2 border-b border-neutral-border/55">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary">{title}</h2>
      </div>
      <div className="px-4 py-3 flex items-center gap-3">
        <p className="text-[13px] text-neutral-text-secondary flex-1">
          Couldn&apos;t load this section.
        </p>
        <button
          type="button"
          onClick={() => { void onRetry(); }}
          className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded
                     text-neutral-text-primary hover:bg-neutral-surface-sunken
                     focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Retry
        </button>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
