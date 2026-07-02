/**
 * Workspace → Settings → Email & SMTP — read-only status (#639, ADR-0084 §5).
 *
 * How TruePPM sends outbound mail. This page confirms the From identity and
 * whether a host is configured. The EMAIL_* transport settings bind from env
 * vars / Helm values (#764); a writable in-app SMTP configuration surface is a
 * separate follow-up (#712).
 */

import type { ReactNode } from 'react';
import { useEmailSettings } from '@/hooks/useEmailSettings';
import { docsUrl } from '@/lib/docsUrl';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';

export function WorkspaceEmailPage() {
  const { data, isLoading, isError, refetch } = useEmailSettings();

  return (
    <div>
      <SettingsPageTitle
        title="Email & SMTP"
        subtitle="How TruePPM sends outbound mail. Transport is configured server-side and read-only here."
      />

      <div className="px-6 py-5 space-y-6 max-w-2xl">
        {isLoading ? (
          <SettingsCard>
            <div className="px-4 py-4 space-y-2" aria-busy="true" aria-label="Loading email settings">
              <div className="h-3 w-1/2 bg-neutral-surface-sunken rounded-chip animate-pulse" />
              <div className="h-3 w-2/3 bg-neutral-surface-sunken rounded-chip animate-pulse" />
            </div>
          </SettingsCard>
        ) : isError || !data ? (
          <SettingsCard className="border-semantic-critical/40">
            <div className="px-4 py-4 flex items-center gap-3" role="alert">
              <p className="flex-1 text-[13px] text-neutral-text-secondary">
                Couldn&apos;t load email settings.
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
        ) : (
          <>
            <SettingsCard>
              <div className="px-4 pt-3.5 pb-2 border-b border-neutral-border/55">
                <h2 className="text-[14px] font-semibold text-neutral-text-primary">Transport</h2>
              </div>
              <dl className="px-4 py-3 grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
                <Row label="Mode">
                  <span className="tppm-mono">{data.transport}</span>
                </Row>
                <Row label="Host">
                  {data.host_configured ? (
                    <span className="tppm-mono">{data.host}</span>
                  ) : (
                    <span className="text-semantic-at-risk">Not configured</span>
                  )}
                </Row>
                {data.port != null && (
                  <Row label="Port">
                    <span className="tppm-mono">
                      {data.port}
                      {data.use_tls ? ' · STARTTLS' : data.use_ssl ? ' · SSL/TLS' : ''}
                    </span>
                  </Row>
                )}
              </dl>
            </SettingsCard>

            <SettingsCard>
              <div className="px-4 pt-3.5 pb-2 border-b border-neutral-border/55">
                <h2 className="text-[14px] font-semibold text-neutral-text-primary">From identity</h2>
              </div>
              <dl className="px-4 py-3 grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
                <Row label="From address">
                  <span className="tppm-mono">{data.from_email || '—'}</span>
                </Row>
              </dl>
            </SettingsCard>

            <SettingsCard className="bg-neutral-surface-sunken">
              <div className="px-4 py-3.5">
                <p className="text-[13px] text-neutral-text-secondary">
                  Email transport is read-only here. Configure the{' '}
                  <span className="tppm-mono">EMAIL_*</span> settings via
                  environment variables / Helm values and redeploy to change
                  transport; a writable in-app SMTP surface is{' '}
                  <a
                    href="https://gitlab.com/trueppm/trueppm/-/issues/712"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-primary underline-offset-2 hover:underline"
                  >
                    #712
                  </a>
                  . See the{' '}
                  <a
                    href={docsUrl('administration/email')}
                    className="text-brand-primary underline-offset-2 hover:underline"
                  >
                    email administration guide
                  </a>{' '}
                  for the current setup.
                </p>
              </div>
            </SettingsCard>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-text-secondary">{label}</dt>
      <dd className="text-neutral-text-primary">{children}</dd>
    </>
  );
}
