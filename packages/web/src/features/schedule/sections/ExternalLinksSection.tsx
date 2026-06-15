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
import { canEditTask } from '@/lib/roles';
import { detectProvider } from '@/lib/detectProvider';
import { safeExternalHref } from '@/lib/safeExternalHref';
import { formatRelative } from '@/lib/formatRelative';
import {
  linkDisplayTitle,
  useCreateTaskLink,
  useDeleteTaskLink,
  useRefreshTaskLink,
  useUpdateTaskLink,
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

/** Read-only label chips on a link row. Text is the signal (no color coding). */
function LabelPills({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1 list-none" aria-label="Labels">
      {labels.map((label, i) => (
        <li
          key={`${label}-${i}`}
          className="inline-flex items-center rounded bg-neutral-surface-sunken px-1.5 py-0.5
            text-xs text-neutral-text-secondary"
        >
          {label}
        </li>
      ))}
    </ul>
  );
}

interface LabelChipInputProps {
  labels: string[];
  onChange: (labels: string[]) => void;
}

/**
 * Editable label chips (#970). Enter or comma commits the draft; Backspace on an
 * empty draft removes the last chip. De-dupes case-insensitively and caps at 12
 * — mirrors the server's `validate_labels` so the UI never offers what the API
 * would reject. The wrapper carries the focus ring (rule 157) since the inner
 * input's outline is suppressed.
 */
function LabelChipInput({ labels, onChange }: LabelChipInputProps) {
  const [draft, setDraft] = useState('');
  const atCap = labels.length >= 12;

  function commitDraft() {
    const label = draft.trim().slice(0, 40);
    setDraft('');
    if (!label || atCap) return;
    if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) return;
    onChange([...labels, label]);
  }

  function removeAt(index: number) {
    onChange(labels.filter((_, i) => i !== index));
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded border border-neutral-border
        bg-neutral-surface px-2 py-1
        focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1 dark:focus-within:ring-semantic-on-track"
    >
      {labels.map((label, i) => (
        <span
          key={`${label}-${i}`}
          className="inline-flex items-center gap-1 rounded bg-neutral-surface-sunken px-1.5 py-0.5
            text-xs text-neutral-text-secondary"
        >
          {label}
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label={`Remove label ${label}`}
            className="rounded text-neutral-text-secondary hover:text-semantic-critical
              focus-visible:ring-2 focus-visible:ring-brand-primary dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commitDraft();
          } else if (e.key === 'Backspace' && !draft && labels.length > 0) {
            removeAt(labels.length - 1);
          }
        }}
        onBlur={commitDraft}
        maxLength={40}
        placeholder={atCap ? 'Label limit reached' : labels.length ? 'Add another…' : 'Add labels…'}
        disabled={atCap}
        aria-label="Add a label"
        className="min-w-[6rem] flex-1 bg-transparent text-xs text-neutral-text-primary
          placeholder:text-neutral-text-secondary focus-visible:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
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
  const update = useUpdateTaskLink();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [connectPrompt, setConnectPrompt] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(link.custom_title);
  const [draftLabels, setDraftLabels] = useState<string[]>(link.labels);

  const title = linkDisplayTitle(link);
  const ts = link.fetched_at ? formatRelative(new Date(link.fetched_at)) : 'never refreshed';
  // Only bind the URL to an href if it is a safe http(s) link. A stored
  // javascript:/data:/malformed URL would otherwise execute on click (#898);
  // when it is unsafe we render the title as inert text instead of an anchor.
  const safeHref = safeExternalHref(link.url);

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

  function startEdit() {
    setDraftTitle(link.custom_title);
    setDraftLabels(link.labels);
    setEditing(true);
  }

  function handleSaveEdit() {
    update.mutate(
      { projectId, taskId, linkId: link.id, customTitle: draftTitle.trim(), labels: draftLabels },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (editing) {
    return (
      <li
        className="flex flex-col gap-2 p-3 rounded border border-neutral-border bg-neutral-surface-raised"
        aria-label={`Edit link: ${title}`}
      >
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          maxLength={512}
          placeholder="Title (optional)"
          aria-label="Link title"
          className="h-8 px-2 text-sm rounded border border-neutral-border bg-neutral-surface
            text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
        />
        <LabelChipInput labels={draftLabels} onChange={setDraftLabels} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveEdit}
            disabled={update.isPending}
            className="text-xs border border-neutral-border rounded px-3 h-8 font-medium
              text-neutral-text-primary hover:bg-neutral-surface disabled:opacity-50
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-neutral-text-secondary rounded px-3 h-8 hover:bg-neutral-surface
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
          >
            Cancel
          </button>
          {update.isError && (
            <span className="text-xs text-semantic-critical" role="alert">
              Save failed.
            </span>
          )}
        </div>
      </li>
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
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-neutral-text-primary truncate hover:underline
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none rounded"
          >
            {title}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        ) : (
          <span
            className="text-sm font-medium text-neutral-text-secondary truncate"
            title="This link can't be opened — it isn't a valid web address."
          >
            {title}
            <span className="sr-only"> (invalid link — not opened)</span>
          </span>
        )}
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
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none disabled:opacity-50"
            aria-label={`Refresh status for ${title}`}
          >
            <span className={refresh.isPending ? 'inline-block motion-safe:animate-spin' : ''}>
              ⟳
            </span>
          </button>
          {canEdit && !confirmingDelete && (
            <button
              type="button"
              onClick={startEdit}
              className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary rounded px-2 h-7
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
              aria-label={`Edit ${title}`}
            >
              ✎
            </button>
          )}
          {canEdit &&
            (!confirmingDelete ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-xs text-neutral-text-secondary hover:text-semantic-critical rounded px-2 h-7
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
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
                    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
                  aria-label={`Confirm delete ${title}`}
                >
                  {remove.isPending ? 'Deleting…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-xs text-neutral-text-secondary rounded px-2 h-7 hover:bg-neutral-surface
                    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
                >
                  Cancel
                </button>
              </>
            ))}
        </span>
      </div>

      <LabelPills labels={link.labels} />

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
  const [customTitle, setCustomTitle] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const detected = detectProvider(url);

  function handleSubmit() {
    if (!detected) return;
    setError(null);
    create.mutate(
      { projectId, taskId, url: url.trim(), customTitle: customTitle.trim(), labels },
      {
        onSuccess: () => {
          setUrl('');
          setCustomTitle('');
          setLabels([]);
        },
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
          type="text"
          inputMode="url"
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
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!detected || create.isPending}
          className="text-xs border border-neutral-border rounded px-3 h-9 font-medium
            text-neutral-text-primary hover:bg-neutral-surface
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {/* Title + labels are progressive — revealed once a valid URL is entered so
          the empty state stays a single paste field. */}
      {detected && (
        <>
          <input
            type="text"
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            maxLength={512}
            placeholder="Title (optional)"
            aria-label="Link title"
            className="h-8 px-2 text-sm rounded border border-neutral-border bg-neutral-surface
              text-neutral-text-primary placeholder:text-neutral-text-secondary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 dark:focus-visible:ring-semantic-on-track focus-visible:outline-none"
          />
          <LabelChipInput labels={labels} onChange={setLabels} />
        </>
      )}

      <span
        id="external-link-hint"
        className="text-xs text-neutral-text-secondary"
        aria-live="polite"
      >
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
 * and refresh links but not add or delete them (1046). The role is threaded
 * through `DrawerSectionProps.userRole`; `canEditTask` returns false while it
 * loads, so the add/delete affordances never flash before the role resolves.
 * The server still 403s a Viewer's write — this is the trust-preserving UX gate.
 */
export function ExternalLinksSection({
  taskId,
  projectId,
  userRole,
  canEdit: canEditCap,
}: DrawerSectionProps) {
  const { links, isLoading, error } = useTaskLinks(projectId, taskId);
  // ADR-0133: prefer the server-derived per-task verdict; fall back to the client
  // role rule only when it is absent (pre-field synced rows).
  const canEdit = canEditCap ?? canEditTask(userRole);

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
          🔗 Paste a GitLab, GitHub, or any URL. GitLab and GitHub links show live status — open,
          draft, merged, or closed — and you can add a title and labels.
        </p>
      )}

      {!isLoading && !error && links.length > 0 && (
        <ul
          aria-label={`External links — ${links.length} total`}
          className="flex flex-col gap-2 list-none"
        >
          {links.map((link) => (
            <ExternalLinkRow
              key={link.id}
              link={link}
              projectId={projectId}
              taskId={taskId}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}

      {!isLoading && !error && canEdit && (
        <AddLinkInput projectId={projectId} taskId={taskId} />
      )}
    </div>
  );
}
