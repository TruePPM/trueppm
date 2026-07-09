/**
 * External source connect wizard (#1421, ADR-0313).
 *
 * An in-page, PAT-based multi-step dialog that fills the seam #1420/ADR-0291 left
 * on the Connected Accounts "Available sources" section. There is no OAuth
 * redirect in OSS (that is Enterprise per ADR-0097) — connecting an external
 * source is a form that ships the user's own API token to
 * `PUT /me/connections/<source>/`, which the backend allow-lists + verifies
 * before storing. The dialog therefore replaces the design's "generic OAuth
 * consent" screen with a credential step, keeping the read-only / never-writes
 * reassurance framing.
 *
 * Steps:
 *   1. credentials — site URL + account email + API token (+ read-only scopes note)
 *   2. configure   — what to pull (assigned-to-me default | custom JQL) + projects
 *   3. connecting  — spinner while the PUT (and a first sync) resolve
 *
 * A `422`/`400` (rejected credential or disallowed host) returns to the
 * credential step with the backend `detail` shown inline.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  type ConnectExternalSourceInput,
  extractConnectionError,
  useConnectExternalSource,
  useSyncExternalSource,
} from '@/hooks/useExternalConnection';
import type { ExternalTaskSourceEntry } from '@/features/integrations/registry';
import { SourceMark } from '@/features/integrations/SourceMark';

type Step = 'credentials' | 'configure' | 'connecting';

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done';

const READ_ONLY_SCOPES = [
  'View issues assigned to you',
  'View issue status, due dates and links',
  'Read your project and board names',
];

interface Props {
  source: ExternalTaskSourceEntry;
  onDismiss: () => void;
  /** Called after a successful connect (before dismiss) so the page can react. */
  onConnected?: () => void;
}

export function ExternalSourceConnectDialog({ source, onDismiss, onConnected }: Props) {
  const titleId = useId();
  const descId = useId();
  const [step, setStep] = useState<Step>('credentials');

  const [baseUrl, setBaseUrl] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [pullMode, setPullMode] = useState<'assigned' | 'jql'>('assigned');
  const [jql, setJql] = useState(DEFAULT_JQL);
  const [projects, setProjects] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = useConnectExternalSource(source.provider);
  const sync = useSyncExternalSource(source.provider);

  const firstFieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Re-seat focus on every step change — a persistent multi-state modal must move
  // focus into the newly-revealed step, not leave it stranded on the prior step's
  // (now-hidden) control. The connecting step has no field, so focus the dialog
  // panel itself rather than dropping to <body> behind the still-open scrim.
  useEffect(() => {
    if (step === 'connecting') {
      panelRef.current?.focus();
      return;
    }
    firstFieldRef.current?.focus();
  }, [step]);

  // Escape closes the dialog — but never mid-connect, where the request is
  // already on the wire and a dismiss would orphan the spinner.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && step !== 'connecting') {
        e.stopPropagation();
        onDismiss();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss, step]);

  function parseProjectKeys(): string[] {
    // Split on commas/whitespace, upper-case, dedupe — Jira project keys are
    // short upper-case tokens (RIV, BAY). Empty → no project filter.
    const keys = projects
      .split(/[\s,]+/)
      .map((k) => k.trim().toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(keys));
  }

  function handleCredentialsNext(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStep('configure');
  }

  function handleConnect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const input: ConnectExternalSourceInput = {
      secret,
      base_url: baseUrl.trim(),
      account_email: accountEmail.trim(),
      // Assigned-to-me is the backend's default when no JQL is stored, so the
      // recommended mode sends an empty filter rather than duplicating the query.
      jql: pullMode === 'jql' ? jql.trim() : '',
      project_keys: parseProjectKeys(),
    };
    setStep('connecting');
    connect.mutate(input, {
      onSuccess: () => {
        // Kick off the first pull so items start populating; fire-and-forget —
        // the connected card reflects "first sync in progress" from the null
        // last_synced_at until the worker lands, and a 429 cooldown here is
        // harmless (a pull is already scheduled).
        sync.mutate();
        onConnected?.();
        onDismiss();
      },
      onError: (err) => {
        // Verification failures are always credential/host related (the verify
        // call hits /myself, not the JQL) — return to that step to fix them.
        setError(
          extractConnectionError(err, `Could not connect to ${source.name}. Check your details and try again.`),
        );
        setStep('credentials');
      },
    });
  }

  const canSubmitCredentials =
    baseUrl.trim() !== '' && accountEmail.trim() !== '' && secret.trim() !== '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && step !== 'connecting') onDismiss();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-md mx-4 p-5 motion-safe:animate-modal-scale-in focus:outline-none"
      >
        <div className="flex items-center gap-2.5 mb-1">
          <SourceMark sourceType={source.provider} label={source.name} />
          <h2 id={titleId} className="text-sm font-semibold text-neutral-text-primary">
            Connect {source.name}
          </h2>
        </div>

        {step === 'credentials' && (
          <form onSubmit={handleCredentialsNext} className="flex flex-col gap-3">
            <p id={descId} className="text-xs text-neutral-text-secondary">
              This connection is personal to you and <strong className="text-neutral-text-primary">read-only</strong> —
              TruePPM pulls your assigned issues into My Work and never writes back to {source.name}.
            </p>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-neutral-text-primary">Site URL</span>
              <input
                ref={firstFieldRef}
                type="url"
                required
                placeholder="https://your-team.atlassian.net"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-neutral-text-primary">Account email</span>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@your-team.com"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
                className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-neutral-text-primary">API token</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              />
              <span className="text-[11px] text-neutral-text-secondary">
                Create a read-only API token in your {source.name} account. It is
                encrypted at rest and never shown again.
              </span>
            </label>

            <div className="flex flex-col gap-1.5 rounded-control border border-neutral-border bg-neutral-surface-sunken px-3 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-semantic-on-track">
                Read-only access
              </span>
              {/* text-primary (not -secondary): text-secondary on surface-sunken is
                  4.36:1 (below AA), and this panel *is* the trust reassurance, so it
                  must be legible — same rationale as the trust-badge row on the page. */}
              <ul className="flex flex-col gap-1">
                {READ_ONLY_SCOPES.map((scope) => (
                  <li key={scope} className="flex items-center gap-2 text-[12px] text-neutral-text-primary">
                    <span aria-hidden="true" className="text-semantic-on-track">✓</span>
                    {scope}
                  </li>
                ))}
              </ul>
              <span className="mt-0.5 text-[12px] text-neutral-text-primary">
                TruePPM <strong>cannot create or edit</strong> anything in {source.name}.
              </span>
            </div>

            {error && (
              <p className="text-[12px] text-semantic-critical" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-1">
              <button
                type="button"
                onClick={onDismiss}
                className="h-8 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmitCredentials}
                className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
              >
                Continue
              </button>
            </div>
          </form>
        )}

        {step === 'configure' && (
          <form onSubmit={handleConnect} className="flex flex-col gap-3">
            <p id={descId} className="text-xs text-neutral-text-secondary">
              Choose what to pull into My Work. Only items matching this end up in
              your list.
            </p>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-[12px] font-medium text-neutral-text-primary mb-1">What to pull</legend>
              <label className="flex items-center gap-2.5 text-[13px] text-neutral-text-primary">
                <input
                  ref={firstFieldRef}
                  type="radio"
                  name="pull-mode"
                  checked={pullMode === 'assigned'}
                  onChange={() => setPullMode('assigned')}
                  className="accent-brand-primary"
                />
                Issues assigned to me
                <span className="text-[11px] font-medium text-brand-primary bg-brand-primary-light rounded-full px-2 py-0.5">
                  Recommended
                </span>
              </label>
              <label className="flex items-center gap-2.5 text-[13px] text-neutral-text-primary">
                <input
                  type="radio"
                  name="pull-mode"
                  checked={pullMode === 'jql'}
                  onChange={() => setPullMode('jql')}
                  className="accent-brand-primary"
                />
                A specific JQL filter
              </label>
              {pullMode === 'jql' && (
                <label className="flex flex-col gap-1">
                  <span className="sr-only">JQL filter</span>
                  <textarea
                    aria-label="JQL filter"
                    rows={2}
                    value={jql}
                    onChange={(e) => setJql(e.target.value)}
                    className="px-3 py-2 font-mono text-[12px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
                  />
                </label>
              )}
            </fieldset>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-neutral-text-primary">
                Projects <span className="text-neutral-text-secondary">(optional)</span>
              </span>
              <input
                type="text"
                placeholder="RIV, BAY"
                value={projects}
                onChange={(e) => setProjects(e.target.value)}
                className="h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              />
              <span className="text-[11px] text-neutral-text-secondary">
                Comma-separated project keys to limit the import. Leave blank for all.
              </span>
            </label>

            {error && (
              <p className="text-[12px] text-semantic-critical" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-between gap-2 mt-1">
              <button
                type="button"
                onClick={() => { setError(null); setStep('credentials'); }}
                className="h-8 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              >
                Back
              </button>
              <button
                type="submit"
                className="h-8 px-3 rounded-control bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary focus-visible:outline-none"
              >
                Start importing
              </button>
            </div>
          </form>
        )}

        {step === 'connecting' && (
          <div className="flex flex-col items-center gap-3 py-8" aria-live="polite">
            <span
              aria-hidden="true"
              className="h-8 w-8 rounded-full border-2 border-brand-primary border-t-transparent motion-safe:animate-spin"
            />
            <p id={descId} className="text-[13px] text-neutral-text-secondary">
              Connecting to {source.name}…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
