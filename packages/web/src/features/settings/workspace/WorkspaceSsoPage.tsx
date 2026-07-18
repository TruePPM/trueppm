/**
 * Workspace → Settings → Single sign-on — multi-provider admin config
 * (#2108, ADR-0517, supersedes #1392/ADR-0187).
 *
 * The admin surface for basic OIDC/OAuth login against the operator's own IdPs.
 * Lists the configured providers (each an allauth `SocialApp` + policy), with an
 * empty state + connect CTA when none exist, and an Add/Edit panel driven by the
 * fixed provider registry. Enabling/disabling and credentials live in the panel;
 * removing a provider deletes its config (and purges its per-user bindings
 * server-side). Basic SSO is part of the Apache-2.0 core — the enforced-SSO
 * (disable local accounts) capability stays an Enterprise upsell, never a
 * functional switch.
 *
 * There is deliberately no workspace-global master toggle: the data model is
 * per-provider (`SsoProviderPolicy.enabled`), and the login screen shows a button
 * for every *enabled* provider. The status card is a derived summary of that.
 */

import { useState } from 'react';
import { useSsoProviders, useDeleteSsoProvider, type SsoProvider } from '@/hooks/useSso';
import { docsUrl } from '@/lib/docsUrl';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { ConfirmDialog } from '../components/integrations/WebhooksManager';
import { providerDef, providerTypeLabel } from './ssoProviders';
import { SsoProviderPanel } from './SsoProviderPanel';

/** Decorative provider tile (glyph + brand hue). The glyph is aria-hidden. */
function ProviderTile({ slug }: { slug: string }) {
  const def = providerDef(slug);
  const color = def?.tile.color ?? '#7fb394';
  return (
    <span
      aria-hidden="true"
      className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-control text-[13px] font-semibold"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {def?.tile.glyph ?? '◎'}
    </span>
  );
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${
        enabled
          ? 'bg-semantic-on-track-bg text-semantic-on-track'
          : 'bg-neutral-surface-sunken text-neutral-text-secondary'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onRemove,
}: {
  provider: SsoProvider;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const def = providerDef(provider.slug);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-border last:border-b-0 flex-wrap">
      <ProviderTile slug={provider.slug} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-neutral-text-primary truncate">
          {provider.display_name || def?.name || provider.slug}
        </p>
        <p className="text-[12px] text-neutral-text-secondary truncate">
          {def ? providerTypeLabel(def) : provider.provider}
        </p>
      </div>
      <StatusPill enabled={provider.enabled} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="h-7 px-3 text-[12px] font-medium border border-semantic-critical/50 rounded-control text-semantic-critical hover:bg-semantic-critical-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

type PanelState = { mode: 'add' } | { mode: 'edit'; provider: SsoProvider } | null;

export function WorkspaceSsoPage() {
  const { data: providers, isLoading, isError, refetch } = useSsoProviders();
  const del = useDeleteSsoProvider();

  const [panel, setPanel] = useState<PanelState>(null);
  const [confirmRemove, setConfirmRemove] = useState<SsoProvider | null>(null);

  if (isError) {
    return (
      <div>
        <SettingsPageTitle title="Single sign-on" />
        <div className="px-6 pb-8 max-w-[920px]">
          <SettingsCard className="border-semantic-critical/40">
            <div className="px-4 py-4 flex items-center gap-3" role="alert">
              <p className="flex-1 text-[13px] text-neutral-text-secondary">
                Couldn&apos;t load the SSO configuration.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="h-7 px-3 text-[12px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          </SettingsCard>
        </div>
      </div>
    );
  }

  if (isLoading || !providers) {
    return (
      <div className="px-6 py-8 space-y-3" aria-label="Loading SSO settings" aria-busy="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 rounded-control bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  const enabledCount = providers.filter((p) => p.enabled).length;
  const live = enabledCount > 0;
  // The redirect URI is identical for every provider (callback path unchanged);
  // reuse any configured provider's value to preview it while adding the next.
  const sharedRedirectUri = providers[0]?.redirect_uri ?? '';

  return (
    <div>
      <SettingsPageTitle
        title="Single sign-on"
        subtitle="Log in with your own identity provider (part of the open-source core)."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Status summary */}
        <SettingsCard
          className={`mb-5 ${live ? 'bg-semantic-on-track-bg' : 'bg-neutral-surface-sunken'}`}
        >
          <div className="px-4 py-3" role="status">
            <p className="text-[13px] font-medium text-neutral-text-primary">
              {live ? 'SSO sign-in is live' : 'SSO sign-in is not enabled yet'}
            </p>
            <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
              {live
                ? `${enabledCount} provider${enabledCount === 1 ? '' : 's'} enabled. Users on an allowed email domain can sign in with your identity provider.`
                : 'Add a provider below and enable it to turn SSO on. Existing password logins keep working until you do.'}
            </p>
          </div>
        </SettingsCard>

        {/* Sign-in providers */}
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[13px] font-semibold text-neutral-text-primary">Sign-in providers</h3>
          {providers.length > 0 && !panel && (
            <button
              type="button"
              onClick={() => setPanel({ mode: 'add' })}
              className="h-8 px-3 text-[13px] font-semibold rounded-control bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Add provider
            </button>
          )}
        </div>

        {providers.length === 0 && !panel ? (
          <SettingsCard className="border-dashed">
            <div className="px-6 py-8 flex flex-col items-center text-center gap-3">
              <span aria-hidden="true" className="text-2xl">
                🔑
              </span>
              <h4 className="text-[15px] font-semibold text-neutral-text-primary">
                No identity provider connected
              </h4>
              <p className="max-w-md text-[13px] text-neutral-text-secondary leading-relaxed">
                Connect an OIDC provider (Keycloak, Authentik, Google, GitLab, …) or GitHub so your
                team can sign in with the accounts they already have. Basic SSO is part of the
                open-source core — no Enterprise license required.
              </p>
              <div className="mt-1 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPanel({ mode: 'add' })}
                  className="h-9 px-4 text-[13px] font-semibold rounded-control bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Add provider
                </button>
                <a
                  href={docsUrl('administration/single-sign-on')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 inline-flex items-center px-3 text-[13px] font-medium border border-neutral-border rounded-control text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Read the docs
                </a>
              </div>
            </div>
          </SettingsCard>
        ) : (
          providers.length > 0 && (
            <SettingsCard className="mb-5">
              {providers.map((p) => (
                <ProviderRow
                  key={p.slug}
                  provider={p}
                  onEdit={() => setPanel({ mode: 'edit', provider: p })}
                  onRemove={() => setConfirmRemove(p)}
                />
              ))}
            </SettingsCard>
          )
        )}

        {/* Add / edit panel */}
        {panel && (
          <div className="mt-3">
            <SsoProviderPanel
              key={panel.mode === 'edit' ? panel.provider.slug : '__add__'}
              mode={panel.mode}
              existing={panel.mode === 'edit' ? panel.provider : undefined}
              sharedRedirectUri={sharedRedirectUri}
              onClose={() => setPanel(null)}
            />
          </div>
        )}
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.display_name || providerDef(confirmRemove.slug)?.name || 'provider'}?`}
          body="This deletes the provider configuration and unlinks anyone who signed in through it. They fall back to password sign-in until it is set up again."
          confirmLabel="Remove provider"
          pending={del.isPending}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const slug = confirmRemove.slug;
            void del.mutateAsync(slug).then(() => {
              setConfirmRemove(null);
              setPanel((prev) =>
                prev && prev.mode === 'edit' && prev.provider.slug === slug ? null : prev,
              );
            });
          }}
        />
      )}
    </div>
  );
}
