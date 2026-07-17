import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentAction } from '@/api/types';
import { VERDICT_DISPLAY } from './agentDisplay';

interface AgentActionDrawerProps {
  action: AgentAction | null;
  /** Resolved display name for the action's project, when known. */
  projectName?: string | null;
  /** Display name for the accountable human principal, when resolvable. */
  principalName?: string | null;
  onClose: () => void;
}

/**
 * Read-only detail slide-over for one agent action (#2020, design §4.2).
 *
 * This is the terminus ADR-0362 §3 requires: a single chain record with its
 * hashes shown verbatim, individually locatable in a `manage.py audit_verify`
 * run. Right slide-over on desktop, bottom sheet on mobile; focus-trapped and
 * Escape-dismissible (web-rule 206 dialog conventions).
 */
export function AgentActionDrawer({
  action,
  projectName,
  principalName,
  onClose,
}: AgentActionDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = action !== null;

  useEffect(() => {
    if (!isOpen) return;
    const id = window.setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!action) return null;
  const verdict = VERDICT_DISPLAY[action.verdict];

  return (
    <>
      {/* Backdrop — mobile only; desktop keeps the list interactive alongside. */}
      <div
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="false"
        aria-label={`Action #${action.sequence}`}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col overflow-y-auto rounded-t-card border-t border-neutral-border bg-neutral-surface p-4 md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:max-h-none md:rounded-none md:border-l md:border-t-0"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-sm font-semibold text-neutral-text-primary">
              Action #{action.sequence}
            </h2>
            <p className="mt-0.5 tppm-mono text-xs text-neutral-text-secondary break-words">
              {action.action} · {action.method}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-control p-1 text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            ✕
          </button>
        </div>

        <div className={`mb-4 flex items-center gap-1.5 text-sm font-medium ${verdict.textClass}`}>
          <span aria-hidden="true">{verdict.symbol}</span>
          {verdict.label}
          {action.capability_used && (
            <span className="tppm-mono text-neutral-text-secondary">
              · {action.capability_used}
            </span>
          )}
        </div>

        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
          <DetailRow label="Actor">
            <span className="tppm-mono">{action.actor_token_prefix || '—'}</span>
            {principalName && (
              <span className="text-neutral-text-secondary"> (on behalf of {principalName})</span>
            )}
          </DetailRow>
          <DetailRow label="Project">{projectName ?? action.project ?? '—'}</DetailRow>
          {action.object_type && (
            <DetailRow label="Object">
              <span className="tppm-mono break-all">
                {action.object_type}
                {action.object_id ? ` · ${action.object_id}` : ''}
              </span>
            </DetailRow>
          )}
          <DetailRow label="Engine">
            <span className="tppm-mono">{action.engine_version || '—'}</span>
          </DetailRow>
          <DetailRow label="When">
            <span className="tppm-mono">{new Date(action.occurred_at).toISOString()}</span>
          </DetailRow>
        </dl>

        <div className="mt-5 border-t border-neutral-border pt-3">
          <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            Chain link
          </h3>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
            <DetailRow label="sequence">
              <span className="tppm-mono">{action.sequence}</span>
            </DetailRow>
            <HashRow label="record_hash" value={action.record_hash} />
            <HashRow label="payload_hash" value={action.payload_hash} />
          </dl>
          <p className="mt-3 text-xs text-neutral-text-disabled">
            This record is verifiable via <span className="tppm-mono">manage.py audit_verify</span>.
          </p>
        </div>
      </div>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-text-secondary">{label}</dt>
      <dd className="m-0 min-w-0 text-neutral-text-primary">{children}</dd>
    </>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // best-effort convenience copy; value stays visible for manual selection
    }
  }
  return (
    <>
      <dt className="text-neutral-text-secondary">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-2 text-neutral-text-primary">
        <span className="tppm-mono truncate" title={value}>
          {value || '—'}
        </span>
        {value && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy ${label}`}
            className="shrink-0 rounded-control border border-neutral-border px-1.5 py-0.5 text-[11px] font-medium text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {copied ? '✓' : 'copy'}
          </button>
        )}
      </dd>
    </>
  );
}
