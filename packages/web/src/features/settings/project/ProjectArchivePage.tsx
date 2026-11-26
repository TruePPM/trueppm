import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiClient } from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { toast } from '@/components/Toast';
import { useFeatureFlag } from '@/lib/featureFlags';
import { FOCUS_RING, PAGE_BUTTON } from '@/components/page2/classes';
import { Button } from '@/components/Button';
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
import { SettingsPageTitle, LearnMoreLink } from '../SettingsShell';
import { LifecycleCard } from '../components/LifecycleCard';
import { TransferOwnershipDialog } from '../components/TransferOwnershipDialog';
import { bundleButtonLabel, exportErrorText, exportStatusLabel } from '../exportJobDisplay';

/** A React-Query/Axios error's message, or null for non-Error rejections. */
function errorMessage(err: unknown): string | null {
  return err instanceof Error ? err.message : null;
}

/**
 * Restore a soft-deleted (trashed) project from the "Undo" toast fired by Move to
 * Trash. Lives at module scope — the Archive page unmounts on navigate, so the Undo
 * closure must reach the stable query/api clients directly rather than a
 * component-scoped mutation observer (issue 1113).
 */
function restoreProject(
  id: string | undefined,
  name: string,
  navigate: ReturnType<typeof useNavigate>,
): void {
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
}

/**
 * Async export bundle card (issue 1266, ADR-0219): queue a richer .tar.gz (JSON seed +
 * MS Project XML + attachments + time entries + audit history), poll queued →
 * running → ready-to-download / failed, then download through the authenticated
 * endpoint. Distinct from the synchronous JSON-seed "Export project" card above:
 * this bundle is Admin-gated and assembled off the request thread.
 */
function ExportBundleCard({ projectId, code }: { projectId: string; code?: string | null }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const start = useStartProjectExport(projectId);
  const { data: job } = useProjectExportJob(projectId, jobId);

  const startError = errorMessage(start.error);
  const building = job?.status === 'pending' || job?.status === 'running';
  const ready = job?.status === 'success' && job.downloadUrl != null;
  const failed = job?.status === 'failed';
  const busy = start.isPending || building;

  const statusLabel = exportStatusLabel(start.isPending, job?.status);
  const errorText = exportErrorText({
    downloadError,
    failed,
    errorDetail: job?.errorDetail,
    startError,
  });

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
        A complete, portable archive of this project as a downloadable .tar.gz — the JSON seed, an
        MS Project XML file (opens in MS Project), every task attachment, all time entries, and the
        project change history. Built in the background; large projects may take a moment.
      </p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        <li className="text-[11px] text-neutral-text-secondary">
          Requires Project Manager or above. The download link expires after a few days.
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
          {bundleButtonLabel(busy, ready, 'Export bundle…')}
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
      {errorText ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {errorText}
        </p>
      ) : null}
      <div>
        <LearnMoreLink
          href="administration/data-export/#export-a-project-bundle-async"
          className="mt-3"
        />
      </div>
    </div>
  );
}

/**
 * Permanent-delete critical zone: type-to-confirm the project code (or name) then
 * delete. `busy` folds the archive-then-delete pending states the parent tracks so
 * this card only needs one flag. Split out of {@link ProjectArchivePage} to keep
 * the page's cognitive complexity in budget (issue #2356) — no rendered change.
 */
function DeleteProjectCard({
  usesCode,
  confirmTarget,
  confirmText,
  onConfirmTextChange,
  confirmed,
  busy,
  onDelete,
  deleteError,
}: {
  usesCode: boolean;
  confirmTarget: string;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  confirmed: boolean;
  busy: boolean;
  onDelete: () => void;
  deleteError: string | null;
}) {
  // Shell v2 phone pass (#5102): the code input and the destructive button stack full width.
  const v2 = useFeatureFlag('shell_v2');
  return (
    <div className="rounded-card border border-semantic-critical bg-semantic-critical-bg p-4">
      <h2 className="text-[13px] font-bold text-semantic-critical mb-1">
        Delete project — permanent
      </h2>
      <p className="text-[12px] text-neutral-text-primary mb-3 leading-relaxed">
        Removes this project and everything in it: tasks, baselines, time entries, attachments.
        Audit-log entries are retained for 365 days for compliance, then purged.{' '}
        <strong className="text-neutral-text-primary">
          Cross-project dependencies in linked projects will fail.
        </strong>
      </p>
      <div className="rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
        <div className="text-[12px] text-neutral-text-secondary mb-2">
          To confirm, type the project {usesCode ? 'code' : 'name'}:
        </div>
        <div className={v2 ? 'flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch' : 'flex items-center gap-2'}>
          <code className="px-2 py-0.5 rounded-chip bg-neutral-surface-sunken border border-neutral-border tppm-mono text-[12px] text-neutral-text-primary">
            {confirmTarget || '…'}
          </code>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => onConfirmTextChange(e.target.value)}
            placeholder={confirmTarget ? `Type ${confirmTarget} to confirm` : 'Loading…'}
            aria-label="Confirm delete by typing the project code or name"
            disabled={!confirmTarget}
            className={[
              v2 ? 'w-[240px] max-md:w-full' : 'w-[240px]',
              'h-8 px-2.5 rounded-control border tppm-mono text-[12px] text-neutral-text-primary bg-neutral-surface-raised',
              'placeholder:text-neutral-text-secondary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical',
              confirmText && !confirmed ? 'border-semantic-critical' : 'border-neutral-border',
            ].join(' ')}
          />
        </div>
      </div>
      <button
        type="button"
        disabled={!confirmed || busy}
        onClick={onDelete}
        className={[
          'px-4 py-2 rounded-control text-[13px] font-semibold text-semantic-on-critical bg-semantic-critical transition-opacity',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
          v2 ? 'max-md:w-full max-md:min-h-11' : '',
          confirmed && !busy ? 'opacity-100 hover:opacity-90' : 'opacity-40 cursor-not-allowed',
        ].join(' ')}
      >
        {busy ? 'Deleting…' : 'Delete project permanently'}
      </button>
      {deleteError ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {deleteError}
        </p>
      ) : null}
      <div>
        <LearnMoreLink href="administration/project-settings/#lifecycle" className="mt-3" />
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
  const transferError = errorMessage(transfer.error);

  const exportSeed = useExportProjectSeed();
  const exportError = errorMessage(exportSeed.error);

  const isArchived = Boolean(project?.is_archived);
  const archiveLabel = isArchived
    ? `Unarchive ${project?.name ?? 'project'}…`
    : `Archive ${project?.name ?? 'project'}…`;

  const archiveError = errorMessage(isArchived ? unarchive.error : archive.error);
  const deleteError = errorMessage(remove.error);

  // Shell v2: archiving names its consequence and asks for the project code first
  // (Unarchive stays one click — it restores, it does not remove). Rule 441: the
  // zone keeps the existing danger treatment, so this adds friction, not a new color.
  const v2 = useFeatureFlag('shell_v2');
  const archiveConfirmId = useId();
  const [archiveArming, setArchiveArming] = useState(false);
  const [archiveConfirmText, setArchiveConfirmText] = useState('');
  const archiveConfirmed = confirmTarget !== '' && archiveConfirmText === confirmTarget;

  const onToggleArchive = () => {
    if (!isArchived && v2) {
      setArchiveArming(true);
      return;
    }
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
          toast.action(`"${name}" moved to Trash`, {
            label: 'Undo',
            ariaLabel: `Undo — restore ${name}`,
            onClick: () => restoreProject(id, name, navigate),
          });
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
                  'Reversible by any Project Admin.',
                ]
          }
          docHref="administration/project-settings/#lifecycle"
          onClick={onToggleArchive}
          busy={archive.isPending || unarchive.isPending}
          error={archiveError}
        />

        {v2 && archiveArming && !isArchived ? (
          <div
            data-testid="archive-confirm"
            className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4"
          >
            <label htmlFor={archiveConfirmId} className="block text-[13px] text-neutral-text-primary">
              Type <span className="tppm-mono font-semibold">{confirmTarget || '…'}</span> to archive.{' '}
              Its tasks leave active views, and any program it belongs to re-forecasts without it.
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                id={archiveConfirmId}
                type="text"
                value={archiveConfirmText}
                onChange={(e) => setArchiveConfirmText(e.target.value)}
                autoComplete="off"
                disabled={!confirmTarget}
                className={`h-9 w-full max-w-[420px] rounded-control border border-neutral-border bg-neutral-surface px-2.5 text-[13px] [@media(pointer:coarse)]:h-11 max-md:h-11 ${FOCUS_RING}`}
              />
              <Button
                variant="danger"
                disabled={!archiveConfirmed || archive.isPending}
                onClick={() => {
                  archive.mutate(undefined as void);
                  setArchiveArming(false);
                  setArchiveConfirmText('');
                }}
                className={`${PAGE_BUTTON} max-md:w-full`}
              >
                Archive project
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setArchiveArming(false);
                  setArchiveConfirmText('');
                }}
                className={`${PAGE_BUTTON} max-md:w-full`}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <LifecycleCard
          title="Transfer ownership"
          tone="warning"
          description="Hand the Project Admin role to another member. You step down to Project Manager."
          actionLabel="Transfer ownership…"
          notes={[
            'The new Project Admin must already be a project member.',
            'You step down to Project Manager when the transfer completes.',
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
        <DeleteProjectCard
          usesCode={Boolean(project?.code)}
          confirmTarget={confirmTarget}
          confirmText={confirmText}
          onConfirmTextChange={setConfirmText}
          confirmed={confirmed}
          busy={remove.isPending || archive.isPending}
          onDelete={onDelete}
          deleteError={deleteError}
        />
      </div>

      {/* One vocabulary per concept (#3513, #3524): name the tier in the scope's role
          labels (`Role`: ordinal 300 → "Project Manager", 400 → "Project Admin"),
          never the raw `Role` enum keys ("Owner"/"Admin"), which the user never sees. */}
      {transferOpen ? (
        <TransferOwnershipDialog
          scope="project"
          scopeId={projectId}
          title="Transfer ownership"
          description="Ownership is the Project Admin role: the selected member becomes Project Admin and you step down to Project Manager."
          ownerPickerLabel="new Project Admin"
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
