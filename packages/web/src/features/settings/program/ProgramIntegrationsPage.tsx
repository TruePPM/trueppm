/**
 * Program → Settings → Integrations — read-only summary page (ADR-0076 extension, #569).
 *
 * Mirrors ProjectIntegrationsPage at program scope: surfaces the program's
 * outbound webhooks (which fire for events on any project in the program) and
 * inbound API tokens (which can authorize writes into any project in the program).
 *
 * A program-scoped webhook is configured ONCE and fires across all the program's
 * child projects, eliminating the need to paste the same Slack URL into N project
 * settings pages. This is the OSS adoption fix for program managers.
 */

import { useParams } from 'react-router';
import { useProgramIntegrationsSummary } from '@/hooks/useProgramIntegrationsSummary';
import type {
  WebhookSummaryItem,
  ApiTokenSummaryItem,
} from '@/hooks/useProjectIntegrationsSummary';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { registry } from '@/lib/widget-registry';

export function ProgramIntegrationsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { summary, isLoading, failedSection, refetch } =
    useProgramIntegrationsSummary(programId);

  if (!programId) return null;

  const webhooks = summary?.webhooks;
  const apiTokens = summary?.api_tokens;

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
        subtitle="Program-wide webhooks and tokens fire across every project in this program. Project-scoped integrations live under each project's settings."
        action={
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
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
// Section: Webhooks (program-scope copy)
// ---------------------------------------------------------------------------

interface WebhooksCardProps {
  isLoading: boolean;
  webhooks:
    | {
        items: WebhookSummaryItem[];
        total: number;
        active_total: number;
        last_delivery_at: string | null;
      }
    | undefined;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}

function WebhooksCard({ isLoading, webhooks, failed, onRetry }: WebhooksCardProps) {
  if (failed) {
    return <SectionErrorCard title="Program webhooks" onRetry={onRetry} />;
  }
  if (isLoading || !webhooks) {
    return <SectionSkeleton title="Program webhooks" />;
  }

  const empty = webhooks.total === 0;

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            Program webhooks
          </h2>
          <span
            className="text-[12px] text-neutral-text-secondary tppm-mono"
            aria-label={`${webhooks.total} program-scoped webhooks`}
          >
            {webhooks.total}
          </span>
        </div>
      </div>

      <div className="px-4 py-3">
        {empty ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No program-wide webhooks configured. Add one to push events from every project
            in this program to a single Slack channel, Discord channel, or HTTP endpoint.
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

      <div className="px-4 pb-3.5 pt-1">
        <span
          className="text-[12px] text-neutral-text-secondary"
          title="Program-scoped webhook CRUD UI lands in 0.3; until then, use the API."
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

// ---------------------------------------------------------------------------
// Section: API Tokens (program-scope copy)
// ---------------------------------------------------------------------------

interface ApiTokensCardProps {
  isLoading: boolean;
  apiTokens:
    | {
        items: ApiTokenSummaryItem[];
        active_total: number;
        last_used_at: string | null;
      }
    | undefined;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}

function ApiTokensCard({ isLoading, apiTokens, failed, onRetry }: ApiTokensCardProps) {
  if (failed) {
    return <SectionErrorCard title="Program API tokens" onRetry={onRetry} />;
  }
  if (isLoading || !apiTokens) {
    return <SectionSkeleton title="Program API tokens" />;
  }

  const empty = apiTokens.active_total === 0;

  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between border-b border-neutral-border/55">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            Program API tokens
          </h2>
          <span
            className="text-[12px] text-neutral-text-secondary tppm-mono"
            aria-label={`${apiTokens.active_total} active program tokens`}
          >
            {apiTokens.active_total}
          </span>
        </div>
      </div>

      <div className="px-4 py-3">
        {empty ? (
          <p className="text-[13px] text-neutral-text-secondary">
            No program-wide tokens. Generate one to let CI or external tools push tasks
            into any project within this program.
          </p>
        ) : (
          <ul className="space-y-2">
            {apiTokens.items.map((tok) => (
              <li key={tok.id} className="flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] text-neutral-text-primary truncate min-w-0 flex-1">
                  {tok.name}
                </span>
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

      <div className="px-4 pb-3.5 pt-1">
        <span
          className="text-[12px] text-neutral-text-secondary"
          title="Program-scoped API Token CRUD UI lands in 0.3; until then, use the API."
        >
          Manage via API (UI coming in 0.3)
        </span>
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
          No program-wide integrations yet
        </h2>
        <p className="text-[13px] text-neutral-text-secondary mb-4">
          This program doesn&apos;t have any webhooks or inbound tokens scoped at the
          program level yet. Configure one here to apply it across every project in the
          program — no per-project copy-paste required.
        </p>
        <ul className="space-y-3 text-[13px]">
          <li className="text-neutral-text-secondary">
            <span className="font-medium text-neutral-text-primary">
              Add a program-wide webhook
            </span>{' '}
            — fires for events on any project in this program (one Slack channel for
            the whole program)
            <span className="block text-[12px] mt-0.5">
              Use the API today; CRUD UI lands in 0.3.
            </span>
          </li>
          <li className="text-neutral-text-secondary">
            <span className="font-medium text-neutral-text-primary">
              Generate a program-wide API token
            </span>{' '}
            — lets CI push tasks into any project in this program; the request
            specifies the target project_id
            <span className="block text-[12px] mt-0.5">
              Use the API today; CRUD UI lands in 0.3.
            </span>
          </li>
        </ul>
        <p className="mt-4 text-[12px] text-neutral-text-secondary">
          Looking for per-project webhooks instead? Open the project and head to
          Settings → Integrations.
        </p>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Section primitives — copied from ProjectIntegrationsPage for visual parity;
// extracted to a shared module in the 0.3 page-de-dup refactor.
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
          onClick={() => {
            void onRetry();
          }}
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
