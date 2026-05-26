/**
 * ExternalLinksSection — task drawer section for git-aware links (ADR-0049 §3, #637).
 *
 * Paste a GitLab/GitHub/any URL on a task; each link shows a cached status badge
 * (open / draft / merged / closed / unknown) with an explicit per-link refresh
 * (synchronous, ~5s — no background polling). When a git provider needs a PAT
 * the user hasn't connected, refresh returns 422 and the row offers a "Connect"
 * shortcut to /me/settings/connected-accounts instead of an error.
 *
 * Registered against `task_detail.section` (priority 450). The reserved
 * `task_detail.external_links` slot (ADR-0076) stays available for Enterprise
 * per-provider card extensions.
 */

import { useState } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { detectProvider } from '@/lib/detectProvider';
import { formatRelative } from '@/lib/formatRelative';
import {
  useCreateTaskLink,
  useDeleteTaskLink,
  useRefreshTaskLink,
  useTaskLinks,
} from '@/hooks/useTaskLinks';
import type { ExternalLinkStatus, TaskExternalLink } from '@/hooks/useTaskLinks';

/** Provider glyph — Unicode for zero icon-library cost (matches AttachmentSection). */
function providerIcon(provider: string): string {
  if (provider === 'github') return '🐙';
  if (provider === 'gitlab') return '🦊';
  return '🔗';
}

interface BadgeStyle {
  label: string;
  text: string;
  dot: string;
}

/**
 * Visual per status. Color is never the only signal — the uppercase label is
 * always present (WCAG 1.4.1). No `info`/purple token exists in the design
 * system, so MERGED maps to brand-primary (the "landed/positive-terminal"
 * color) and DRAFT to at-risk (orange).
 */
const BADGE_STYLES: Record<ExternalLinkStatus, BadgeStyle> = {
  open: { label: 'OPEN', text: 'text-semantic-on-track', dot: 'bg-semantic-on-track' },
  draft: { label: 'DRAFT', text: 'text-semantic-at-risk', dot: 'bg-semantic-at-risk opacity-60' },
  merged: { label: 'MERGED', text: 'text-brand-primary', dot: 'bg-brand-primary' },
  closed: { label: 'CLOSED', text: 'text-semantic-critical', dot: 'bg-semantic-critical' },
  unknown: {
    label: 'UNKNOWN',
    text: 'text-neutral-text-secondary',
    dot: 'border border-neutral-border',
  },
};

interface StatusBadgeProps {
  status: ExternalLinkStatus;
  /** Generic links have no lifecycle status — show a neutral em dash. */
  provider: string;
}

/** Colored-dot + uppercase-label status pill (mirrors the Connected Accounts pill). */
export function StatusBadge({ status, provider }: StatusBadgeProps) {
  const style = BADGE_STYLES[status];
  const isGenericUnknown = provider === 'generic' && status === 'unknown';
  const label = isGenericUnknown ? '—' : style.label;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide ${style.text}`}
      aria-label={`Status: ${isGenericUnknown ? 'not applicable' : status}`}
    >
      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {label}
    </span>
  );
}

/** Short ref for the meta line: `!42` (MR), `#42` (PR/issue), else the host. */
function shortRef(link: TaskExternalLink): string {
  try {
    const u = new URL(link.url);
    const m = u.pathname.match(/\/(?:merge_requests)\/(\d+)/);
    if (m) return `!${m[1]}`;
    const p = u.pathname.match(/\/(?:pull|issues)\/(\d+)/);
    if (p) return `#${p[1]}`;
    return u.host;
  } catch {
    return link.url;
  }
}

interface ExternalLinkRowProps {
  link: TaskExternalLink;
  projectId: string;
  taskId: string;
  canEdit: boolean;
}

function ExternalLinkRow({ link, projectId, taskId, canEdit }: ExternalLinkRowProps) {
  const refresh = useRefreshTaskLink();
  const remove = useDeleteTaskLink();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [connectPrompt, setConnectPrompt] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const title = link.title || link.url;
  const ts = link.fetched_at ? formatRelative(new Date(link.fetched_at)) : 'never refreshed';

  function handleRefresh() {
    setConnectPrompt(null);
    setRefreshFailed(false);
    refresh.mutate(
      { projectId, taskId, linkId: link.id },
      {
        onError: (err: unknown) => {
          const data = (err as { response?: { data?: { code?: string; provider?: string } } })
            .response?.data;
          if (data?.code === 'credential_required') {
            setConnectPrompt(data.provider ?? link.provider);
          } else {
            setRefreshFailed(true);
          }
        },
      },
    );
  }

  function handleDelete() {
    remove.mutate(
      { projectId, taskId, linkId: link.id },
      { onSettled: () => setConfirmingDelete(false) },
    );
  }

  return (
    <li
      className="flex flex-col gap-1 p-3 rounded border border-neutral-border bg-neutral-surface-raised"
      aria-label={`Link: ${title}`}
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-base flex-shrink-0" aria-hidden="true">
          {providerIcon(link.provider)}
        </span>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-neutral-text-primary truncate hover:underline
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded"
        >
          {title}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
        <span className={`ml-auto flex-shrink-0 ${refresh.isPending ? 'opacity-60' : ''}`}>
          <StatusBadge status={link.status} provider={link.provider} />
        </span>
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-neutral-text-secondary tppm-mono truncate">
          {shortRef(link)} · {ts}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refresh.isPending}
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary rounded px-2 h-7
              focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none disabled:opacity-50"
            aria-label={`Refresh status for ${title}`}
          >
            <span className={refresh.isPending ? 'inline-block motion-safe:animate-spin' : ''}>⟳</span>
          </button>
          {canEdit &&
            (!confirmingDelete ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-xs text-neutral-text-secondary hover:text-semantic-critical rounded px-2 h-7
                  focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
                aria-label={`Delete ${title}`}
              >
                ✕
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={remove.isPending}
                  className="text-xs bg-semantic-critical text-white rounded px-2 h-7 font-medium
                    hover:opacity-90 disabled:opacity-50
                    focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
                  aria-label={`Confirm delete ${title}`}
                >
                  {remove.isPending ? 'Deleting…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-xs text-neutral-text-secondary rounded px-2 h-7 hover:bg-neutral-surface
                    focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
                >
                  Cancel
                </button>
              </>
            ))}
        </span>
      </div>

      {connectPrompt && (
        <a
          href={`/me/settings/connected-accounts#${connectPrompt}`}
          className="text-xs text-brand-primary hover:underline mt-1"
          aria-label={`Connect ${connectPrompt} to see status for this link`}
        >
          Connect {connectPrompt} to see status ↗
        </a>
      )}
      {refreshFailed && (
        <span className="text-xs text-semantic-critical mt-1" role="alert">
          ⚠ Couldn&apos;t refresh — try again.
        </span>
      )}
      {remove.isError && (
        <span className="text-xs text-semantic-critical mt-1" role="alert">
          Delete failed.
        </span>
      )}
    </li>
  );
}

interface AddLinkInputProps {
  projectId: string;
  taskId: string;
}

function AddLinkInput({ projectId, taskId }: AddLinkInputProps) {
  const create = useCreateTaskLink();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detected = detectProvider(url);

  function handleSubmit() {
    if (!detected) return;
    setError(null);
    create.mutate(
      { projectId, taskId, url: url.trim() },
      {
        onSuccess: () => setUrl(''),
        onError: (err) => setError(err.message || 'Could not add link.'),
      },
    );
  }

  const hint =
    detected === 'github'
      ? '🐙 GitHub detected · refresh fetches live status'
      : detected === 'gitlab'
        ? '🦊 GitLab detected · refresh fetches live status'
        : detected === 'generic'
          ? '🔗 Saved as a generic link (no live status)'
          : '';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
          placeholder="Paste a GitLab, GitHub, or any URL…"
          aria-label="Add a link URL"
          aria-describedby="external-link-hint"
          className="flex-1 h-9 px-2 text-sm rounded border border-neutral-border bg-neutral-surface
            text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!detected || create.isPending}
          className="text-xs border border-neutral-border rounded px-3 h-9 font-medium
            text-neutral-text-primary hover:bg-neutral-surface
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <span id="external-link-hint" className="text-xs text-neutral-text-secondary" aria-live="polite">
        {hint}
      </span>
      {error && (
        <span className="text-xs text-semantic-critical" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Drawer section body. `canEdit` follows task-edit permission — Viewers can see
 * and refresh links but not add or delete them. The drawer doesn't pass a role,
 * so we surface add/delete always and let the server 403 a Viewer's write; for
 * a cleaner UX a future pass can thread the role through DrawerSectionProps.
 */
export function ExternalLinksSection({ taskId, projectId }: DrawerSectionProps) {
  const { links, isLoading, error } = useTaskLinks(projectId, taskId);

  return (
    <div className="flex flex-col gap-2">
      {isLoading && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading links">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-semantic-critical" role="alert">
          Couldn&apos;t load links.
        </p>
      )}

      {!isLoading && !error && links.length === 0 && (
        <p
          role="note"
          className="text-xs text-neutral-text-secondary border border-dashed border-neutral-border
            bg-neutral-surface-sunken rounded px-4 py-3"
        >
          🔗 Paste a GitLab or GitHub URL to see live status — open, draft, merged, or closed — on
          this task.
        </p>
      )}

      {!isLoading && !error && links.length > 0 && (
        <ul aria-label={`External links — ${links.length} total`} className="flex flex-col gap-2 list-none">
          {links.map((link) => (
            <ExternalLinkRow
              key={link.id}
              link={link}
              projectId={projectId}
              taskId={taskId}
              canEdit
            />
          ))}
        </ul>
      )}

      {!isLoading && !error && <AddLinkInput projectId={projectId} taskId={taskId} />}
    </div>
  );
}
