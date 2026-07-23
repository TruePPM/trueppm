import { useState } from 'react';
import { useNavigate } from 'react-router';
import { docsUrl } from '@/lib/docsUrl';
import { apiClient } from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { toast } from '@/components/Toast';
import { useProject } from '@/hooks/useProject';
import { useProjectId } from '@/hooks/useProjectId';
import {
  useArchiveProject,
  useDeleteProject,
  useTransferProject,
  useUnarchiveProject,
} from '@/hooks/useProjectMutations';
import { useExportProjectSeed } from '@/hooks/useProgramSeedIo';
import {
  downloadProjectExport,
  useProjectExportJob,
  useStartProjectExport,
} from '../hooks/useProjectExport';
import { SettingsPageTitle } from '../SettingsShell';
import { TransferOwnershipDialog } from '../components/TransferOwnershipDialog';

/**
 * A "Learn more →" docs deep-link for a lifecycle card (web-rule 263). Rendered
 * as an `<a>` (not a button) so destructive/lifecycle cards get a per-card docs
 * link rather than a per-input ⓘ popover, per the #2266 rule for these actions.
 *
 * `href` is a docs-site slug (+#anchor), passed through {@link docsUrl}.
 */
function LearnMoreLink({ href, label = 'Learn more' }: { href: string; label?: string }) {
  return (
    <a
      href={docsUrl(href)}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-flex items-center gap-1 rounded text-[11px] font-medium text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      {label}
      <span aria-hidden="true">→</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

interface LifecycleCardProps {
  title: string;
  tone: 'neutral' | 'warning';
  description: string;
  actionLabel: string;
  notes: string[];
  disabled?: boolean;
  /** When the card is a not-yet-wired placeholder, the reason shown on hover
   *  (and as the accessible title) — should link the tracking issue, e.g. "… — tracked in #967". */
  disabledReason?: string;
  /** Docs-site slug (+#anchor) for this card's "Learn more →" link (web-rule 263). */
  docHref?: string;
  onClick?: () => void;
  busy?: boolean;
  error?: string | null;
}

function LifecycleCard({
  title,
  tone,
  description,
  actionLabel,
  notes,
  disabled,
  disabledReason,
  docHref,
  onClick,
  busy,
  error,
}: LifecycleCardProps) {
  const isWarning = tone === 'warning';
  return (
    <div
      className={[
        'rounded-card border p-4',
        // Warning tone uses the adaptive semantic-warning tokens (amber wash +
        // AA border) rather than the static bg-brand-accent-light (#FFF3CD),
        // which stays cream in dark mode while the neutral text tokens invert to
        // light ink — washing the card out to unreadable (issue 1619, rule 86).
        // Mirrors the sibling Delete card's border-semantic-critical bg-…-bg.
        isWarning
          ? 'border-semantic-warning/70 bg-semantic-warning-bg'
          : 'border-neutral-border bg-neutral-surface-raised',
      ].join(' ')}
    >
      <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-1">{title}</h2>
      <p className="text-[12px] text-neutral-text-secondary mb-2 leading-relaxed">{description}</p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        {notes.map((n) => (
          <li key={n} className="text-[11px] text-neutral-text-secondary">{n}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy || !onClick}
        title={disabled && !busy ? disabledReason : undefined}
        className={[
          'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium',
          'text-neutral-text-primary hover:bg-neutral-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        {busy ? 'Working…' : actionLabel}
      </button>
      {error ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {error}
        </p>
      ) : null}
      {docHref ? (
        <div>
          <LearnMoreLink href={docHref} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Async export bundle card (issue 1266, ADR-0219): queue a richer .tar.gz (JSON seed +
 * MS Project XML + attachments + time entries + audit history), poll queued →
 * running → ready-to-download / failed, then download through the authenticated
 * endpoint. Distinct from the synchronous JSON-seed "Export project" card above:
 * this bundle is Admin-gated and assembled off the request thread.
 */
function ExportBundleCard({
  projectId,
  code,
}: {
  projectId: string;
  code?: string | null;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const start = useStartProjectExport(projectId);
  const { data: job } = useProjectExportJob(projectId, jobId);

  const startError = start.error instanceof Error ? start.error.message : null;
  const building = job?.status === 'pending' || job?.status === 'running';
  const ready = job?.status === 'success' && job.downloadUrl != null;
  const failed = job?.status === 'failed';
  const busy = start.isPending || building;

  const statusLabel = start.isPending
    ? 'Queuing…'
    : job?.status === 'pending'
      ? 'Queued…'
      : job?.status === 'running'
        ? 'Building bundle…'
        : null;

  const onStart = () => {
    setDownloadError(null);
    start.mutate(undefined as void, { onSuccess: (j) => setJobId(j.id) });
  };

  const onDownload = () => {
    if (!job) return;
    setDownloadError(null);
    downloadProjectExport(projectId, job, code).catch(() => {
      setDownloadError('Download failed — the link may have expired. Build a new bundle.');
    });
  };

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
      <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-1">Export bundle</h2>
      <p className="text-[12px] text-neutral-text-secondary mb-2 leading-relaxed">
        A complete, portable archive of this project as a downloadable .tar.gz — the JSON seed,
        an MS Project XML file (opens in MS Project), every task attachment, all time entries,
        and the project change history. Built in the background; large projects may take a moment.
      </p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        <li className="text-[11px] text-neutral-text-secondary">
          Admin+ only. The download link expires after a few days.
        </li>
        <li className="text-[11px] text-neutral-text-secondary">
          MS Project artifact is XML (.xml) — binary .mpp is not generated.
        </li>
      </ul>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={ready ? onDownload : onStart}
          disabled={busy}
          className={[
            'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium',
            'text-neutral-text-primary hover:bg-neutral-surface-sunken',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {busy ? 'Working…' : ready ? 'Download bundle' : 'Export bundle…'}
        </button>
        {statusLabel ? (
          <span className="text-[11px] text-neutral-text-secondary" role="status">
            {statusLabel}
          </span>
        ) : null}
        {ready ? (
          <button
            type="button"
            onClick={onStart}
            className="text-[11px] text-neutral-text-secondary underline hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            Rebuild
          </button>
        ) : null}
      </div>
      {startError || failed || downloadError ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {downloadError ??
            (failed
              ? `Export failed${job?.errorDetail ? `: ${job.errorDetail}` : ''}. Try again.`
              : startError)}
        </p>
      ) : null}
      <div>
        <LearnMoreLink href="administration/data-export/#export-a-project-bundle-async" />
      </div>
    </div>
  );
}

/** Project > Lifecycle (archive / transfer / delete) settings page. */
export function ProjectArchivePage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const navigate = useNavigate();

  // The typed-confirmation phrase. Prefer the project ``code`` (shorter, used
  // as the task-ID prefix) and fall back to ``name`` for projects without a
  // code yet (#523 backfill). An empty string keeps the dialog locked until
  // the project record loads.
  const confirmTarget = (project?.code || project?.name || '').trim();

  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmTarget !== '' && confirmText === confirmTarget;

  const archive = useArchiveProject(projectId);
  const unarchive = useUnarchiveProject(projectId);
  const remove = useDeleteProject(projectId);
  const transfer = useTransferProject(projectId);

  const [transferOpen, setTransferOpen] = useState(false);
  const transferError = transfer.error instanceof Error ? transfer.error.message : null;

  const exportSeed = useExportProjectSeed();
  const exportError = exportSeed.error instanceof Error ? exportSeed.error.message : null;

  const isArchived = Boolean(project?.is_archived);
  const archiveLabel = isArchived
    ? `Unarchive ${project?.name ?? 'project'}…`
    : `Archive ${project?.name ?? 'project'}…`;

  const archiveError =
    (isArchived ? unarchive.error : archive.error) instanceof Error
      ? (isArchived ? unarchive.error : archive.error)!.message
      : null;
  const deleteError = remove.error instanceof Error ? remove.error.message : null;

  const onToggleArchive = () => {
    if (isArchived) {
      unarchive.mutate(undefined as void);
    } else {
      archive.mutate(undefined as void);
    }
  };

  const onDelete = () => {
    // Permanent delete requires the project to already be archived (server-enforced);
    // archive first if needed so the click is a single intent for the user.
    const run = () =>
      remove.mutate(
        { force: true },
        {
          onSuccess: () => {
            void navigate('/', { replace: true });
          },
        },
      );
    if (!isArchived) {
      archive.mutate(undefined as void, {
        onSuccess: run,
      });
      return;
    }
    run();
  };

  // Move to Trash — the recoverable soft-delete (issue 1113). Distinct from the permanent
  // delete below: no type-to-confirm (reversibility is the safety net), fires an
  // inline "Undo" toast, and navigates home. The Undo closure calls the restore
  // endpoint directly via the stable queryClient/apiClient — this page unmounts on
  // navigate, so it must not depend on a component-scoped mutation observer.
  const onMoveToTrash = () => {
    const name = project?.name ?? 'Project';
    const id = projectId;
    remove.mutate(
      { force: false },
      {
        onSuccess: () => {
          toast.action(
            `"${name}" moved to Trash`,
            {
              label: 'Undo',
              ariaLabel: `Undo — restore ${name}`,
              onClick: () => {
                apiClient
                  .post(`/projects/${id}/restore/`)
                  .then(() => {
                    void queryClient.invalidateQueries({ queryKey: ['projects'] });
                    void queryClient.invalidateQueries({ queryKey: ['projects-trash'] });
                    void queryClient.invalidateQueries({ queryKey: ['project', id] });
                    toast.success(`"${name}" restored`);
                    void navigate(`/projects/${id}`);
                  })
                  .catch(() => {
                    toast.error('Could not restore — open Trash to try again');
                  });
              },
            },
          );
          void navigate('/', { replace: true });
        },
      },
    );
  };

  return (
    <div>
      <SettingsPageTitle
        title="Lifecycle"
        subtitle="Closing out, handing off, or removing this project. All actions write to the audit log."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-3.5">
        <LifecycleCard
          title={isArchived ? 'Unarchive project' : 'Archive project'}
          tone="neutral"
          description={
            isArchived
              ? 'Restore writes to this project. Members regain edit access and the project re-appears in active views.'
              : 'Freezes the project. Members keep read-only access; tasks no longer appear in active views or rollups.'
          }
          actionLabel={archiveLabel}
          notes={
            isArchived
              ? ['Reversible — returns the project to its previous state.']
              : [
                  'Retains baselines, audit log, time entries, attachments.',
                  'Reversible by any Owner.',
                ]
          }
          docHref="administration/project-settings/#lifecycle"
          onClick={onToggleArchive}
          busy={archive.isPending || unarchive.isPending}
          error={archiveError}
        />

        <LifecycleCard
          title="Transfer ownership"
          tone="warning"
          description="Hand the Owner role to another member. The current Owner becomes an Admin."
          actionLabel="Transfer ownership…"
          notes={[
            'New owner must already be a project member.',
            'You are demoted to Admin when the transfer completes.',
          ]}
          docHref="administration/rbac"
          onClick={() => setTransferOpen(true)}
          busy={transfer.isPending}
          error={transferError}
        />

        <LifecycleCard
          title="Export project"
          tone="neutral"
          description="Download this project as a portable JSON seed: tasks, sprints, dependencies, baselines, risks, and resources. Re-importable into any TruePPM workspace."
          actionLabel="Export project…"
          notes={[
            'Portable canonical JSON — re-imports via Programs → Import.',
            'For a client-ready document, use the board PDF export instead.',
          ]}
          docHref="administration/data-export/#export-a-project"
          onClick={() => exportSeed.mutate({ projectId, code: project?.code })}
          busy={exportSeed.isPending}
          error={exportError}
        />

        {projectId ? <ExportBundleCard projectId={projectId} code={project?.code} /> : null}

        <LifecycleCard
          title="Move to Trash"
          tone="warning"
          description="Removes this project and its tasks, sprints, and baselines from active views. It stays recoverable in Trash during the retention window, then is permanently deleted."
          actionLabel="Move to Trash…"
          notes={[
            'Reversible — restore any time before the window closes (Workspace → Trash).',
            'Cross-project dependencies are re-linked on restore.',
          ]}
          docHref="administration/retention"
          onClick={onMoveToTrash}
          busy={remove.isPending}
        />

        {/* Delete — critical zone */}
        <div className="rounded-card border border-semantic-critical bg-semantic-critical-bg p-4">
          <h2 className="text-[13px] font-bold text-semantic-critical mb-1">
            Delete project — permanent
          </h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-relaxed">
            Removes this project and everything in it: tasks, baselines, time entries, attachments. Audit-log
            entries are retained for 365 days for compliance, then purged.{' '}
            <strong className="text-neutral-text-primary">
              Cross-project dependencies in linked projects will fail.
            </strong>
          </p>
          <div className="rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
            <div className="text-[12px] text-neutral-text-secondary mb-2">
              To confirm, type the project {project?.code ? 'code' : 'name'}:
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-0.5 rounded-chip bg-neutral-surface-sunken border border-neutral-border tppm-mono text-[12px] text-neutral-text-primary">
                {confirmTarget || '…'}
              </code>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={confirmTarget ? `Type ${confirmTarget} to confirm` : 'Loading…'}
                aria-label="Confirm delete by typing the project code or name"
                disabled={!confirmTarget}
                className={[
                  'w-[240px] h-8 px-2.5 rounded-control border tppm-mono text-[12px] text-neutral-text-primary bg-neutral-surface-raised',
                  'placeholder:text-neutral-text-secondary',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical',
                  confirmText && !confirmed ? 'border-semantic-critical' : 'border-neutral-border',
                ].join(' ')}
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!confirmed || remove.isPending || archive.isPending}
            onClick={onDelete}
            className={[
              'px-4 py-2 rounded-control text-[13px] font-semibold text-white bg-semantic-critical transition-opacity',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
              confirmed && !remove.isPending && !archive.isPending
                ? 'opacity-100 hover:opacity-90'
                : 'opacity-40 cursor-not-allowed',
            ].join(' ')}
          >
            {remove.isPending || archive.isPending
              ? 'Deleting…'
              : 'Delete project permanently'}
          </button>
          {deleteError ? (
            <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div>
            <LearnMoreLink href="administration/project-settings/#lifecycle" />
          </div>
        </div>
      </div>

      {transferOpen ? (
        <TransferOwnershipDialog
          scope="project"
          scopeId={projectId}
          title="Transfer ownership"
          description="The selected member becomes the project Owner. You are demoted to Admin. The new owner must already be a project member."
          ownerPickerLabel="new owner"
          error={transferError}
          busy={transfer.isPending}
          onCancel={() => setTransferOpen(false)}
          onConfirm={({ newOwnerId }) => {
            transfer.mutate(
              { new_owner_user_id: newOwnerId },
              { onSuccess: () => setTransferOpen(false) },
            );
          }}
        />
      ) : null}
    </div>
  );
}
