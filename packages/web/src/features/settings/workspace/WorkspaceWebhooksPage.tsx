import { SettingsPageTitle, FieldRow, SettingsCard } from '../SettingsShell';

const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.deleted',
  'task.assigned', 'task.status_changed',
  'project.created', 'project.archived',
  'member.invited', 'member.removed',
  'baseline.saved', 'schedule.computed',
  'sprint.started', 'sprint.closed',
] as const;

/** Workspace > Webhooks & API page. */
export function WorkspaceWebhooksPage() {
  return (
    <div>
      <SettingsPageTitle
        title="Webhooks & API"
        subtitle="Outbound webhooks and API token management for automations and integrations."
        action={
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + New webhook
          </button>
        }
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-6">
        {/* API Tokens */}
        <section aria-labelledby="tokens-heading">
          <h2 id="tokens-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            API tokens
          </h2>
          <SettingsCard>
            <div className="px-4 py-3 flex items-center gap-3 border-b border-neutral-border/55">
              <div>
                <div className="text-[13px] font-medium text-neutral-text-primary">CI/CD pipeline token</div>
                <div className="tppm-mono text-[11px] text-neutral-text-secondary">tp_live_•••• •••• •••• 4d7f · Created Apr 3 2026 · Last used 2h ago</div>
              </div>
              <div className="flex-1" />
              <span className="text-[11px] px-2 py-0.5 rounded bg-semantic-on-track-bg text-semantic-on-track font-semibold">Active</span>
              <button type="button" className="text-[12px] text-semantic-critical hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded">
                Revoke
              </button>
            </div>
            <div className="px-4 py-3 flex items-center gap-3">
              <div>
                <div className="text-[13px] font-medium text-neutral-text-primary">Slack bot integration</div>
                <div className="tppm-mono text-[11px] text-neutral-text-secondary">tp_live_•••• •••• •••• 9a12 · Created Mar 14 2026 · Last used 14m ago</div>
              </div>
              <div className="flex-1" />
              <span className="text-[11px] px-2 py-0.5 rounded bg-semantic-on-track-bg text-semantic-on-track font-semibold">Active</span>
              <button type="button" className="text-[12px] text-semantic-critical hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical rounded">
                Revoke
              </button>
            </div>
          </SettingsCard>
          <button
            type="button"
            className="mt-2 px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            + Create token
          </button>
        </section>

        {/* Outbound webhooks */}
        <section aria-labelledby="hooks-heading">
          <h2 id="hooks-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Outbound webhooks
          </h2>
          <SettingsCard>
            <div className="px-4 py-3 border-b border-neutral-border/55">
              <FieldRow label="Endpoint URL" hint="HTTPS required. Must return 2xx within 10 seconds.">
                <input
                  type="url"
                  placeholder="https://hooks.example.com/trueppm"
                  className="w-full h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] font-mono text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                />
              </FieldRow>
              <div className="mt-4">
                <div className="text-[13px] font-medium text-neutral-text-primary mb-2">Events to send</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {WEBHOOK_EVENTS.map((evt) => (
                    <label key={evt} className="flex items-center gap-2 text-[12px] text-neutral-text-secondary cursor-pointer">
                      <span className="w-3.5 h-3.5 rounded border border-neutral-border bg-neutral-surface shrink-0" aria-hidden="true" />
                      <input type="checkbox" className="sr-only" />
                      <span className="font-mono">{evt}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-4 py-3 flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Send test event
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Save webhook
              </button>
            </div>
          </SettingsCard>
        </section>
      </div>
    </div>
  );
}
