import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/stores/authStore';
import { SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useWorkspaceMembers } from '../hooks/useWorkspaceMembers';
import {
  downloadWorkspaceExport,
  useDeleteWorkspace,
  useStartWorkspaceExport,
  useTransferWorkspaceOwnership,
  useWorkspaceExportJob,
} from '../hooks/useWorkspaceLifecycle';

const WORKSPACE_OWNER_ROLE = 400; // WorkspaceRole.OWNER ordinal

interface InlineToast {
  message: string;
  variant: 'error' | 'success';
}

function errorMessage(err: unknown, fallback: string): string {
  // axios errors carry the API `detail` at response.data.detail.
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  return err instanceof Error ? err.message : fallback;
}

/** Workspace > Archive / Delete danger zone — transfer / export / delete (#641). */
export function WorkspaceDangerPage() {
  const navigate = useNavigate();
  const clearTokens = useAuthStore((s) => s.clearTokens);

  const { data: workspace } = useWorkspaceSettings();
  const { members } = useWorkspaceMembers();

  // Confirm phrase is the workspace name (always populated; subdomain may be
  // blank). The DELETE endpoint matches the X-Confirm-Workspace header to it.
  const confirmTarget = (workspace?.name ?? '').trim();

  const [toast, setToast] = useState<InlineToast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Transfer ownership -------------------------------------------------
  const transfer = useTransferWorkspaceOwnership();
  const [newOwnerId, setNewOwnerId] = useState('');
  // Candidates: active members who are not already an owner.
  const transferCandidates = useMemo(
    () => members.filter((m) => m.status === 'active' && m.roleValue < WORKSPACE_OWNER_ROLE),
    [members],
  );

  const onTransfer = () => {
    if (!newOwnerId) return;
    transfer.mutate(Number(newOwnerId), {
      onSuccess: () => {
        setNewOwnerId('');
        setToast({
          message: 'Workspace ownership transferred. You are now an Admin.',
          variant: 'success',
        });
      },
      onError: (err) =>
        setToast({
          message: errorMessage(err, 'Could not transfer ownership.'),
          variant: 'error',
        }),
    });
  };

  // --- Export -------------------------------------------------------------
  const startExport = useStartWorkspaceExport();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const { data: exportJob } = useWorkspaceExportJob(activeJobId);
  const [downloading, setDownloading] = useState(false);

  const onStartExport = () => {
    startExport.mutate(undefined, {
      onSuccess: (job) => {
        setActiveJobId(job.id);
        setToast({
          message: "Export queued — we'll email you a download link when it's ready.",
          variant: 'success',
        });
      },
      onError: (err) =>
        setToast({ message: errorMessage(err, 'Could not start the export.'), variant: 'error' }),
    });
  };

  const onDownload = async () => {
    if (!exportJob) return;
    setDownloading(true);
    try {
      await downloadWorkspaceExport(exportJob);
    } catch (err) {
      setToast({
        message: errorMessage(err, 'Download failed — the link may have expired.'),
        variant: 'error',
      });
    } finally {
      setDownloading(false);
    }
  };

  const exportStatus = exportJob?.status;
  const exportBusy =
    startExport.isPending || exportStatus === 'pending' || exportStatus === 'running';

  // --- Delete -------------------------------------------------------------
  const remove = useDeleteWorkspace();
  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmTarget !== '' && confirmText === confirmTarget;
  const deleteError = remove.error ? errorMessage(remove.error, 'Delete failed.') : null;

  const onDelete = () => {
    remove.mutate(confirmTarget, {
      onSuccess: () => {
        // The workspace (and the session's data) is gone — drop tokens and
        // bounce to login, where a fresh default workspace materializes.
        clearTokens();
        void navigate('/login', { replace: true });
      },
    });
  };

  return (
    <div>
      <SettingsPageTitle
        title="Archive / Delete"
        subtitle="Irreversible workspace-wide actions. Each requires explicit confirmation."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-4">
        {/* Export ----------------------------------------------------------- */}
        <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">Export all data</h2>
          <p className="text-[13px] text-neutral-text-secondary mt-1 leading-snug">
            Download a full archive (JSON + attachments) of all workspace data: members, groups,
            programs, projects, tasks, baselines, and history. We email a download link when it is
            ready; the link expires after a few days.
          </p>
          <div className="mt-3 flex items-center gap-3">
            {exportStatus === 'success' && exportJob ? (
              <button
                type="button"
                onClick={() => void onDownload()}
                disabled={downloading}
                className="shrink-0 px-3 py-1.5 rounded-control border border-brand-primary text-[13px] font-medium text-brand-primary hover:bg-brand-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-60"
              >
                {downloading ? 'Downloading…' : 'Download archive'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartExport}
                disabled={exportBusy}
                className="shrink-0 px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary"
              >
                {exportBusy ? 'Building export…' : 'Export all data'}
              </button>
            )}
            <p className="text-[12px] text-neutral-text-secondary" role="status" aria-live="polite">
              {exportStatus === 'pending' || exportStatus === 'running'
                ? 'Queued — this can take a while for a large workspace.'
                : exportStatus === 'success'
                  ? 'Ready to download.'
                  : exportStatus === 'failed'
                    ? 'Last export failed — try again.'
                    : ''}
            </p>
          </div>
        </div>

        {/* Transfer ownership ---------------------------------------------- */}
        <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
          <h2 className="text-[14px] font-semibold text-neutral-text-primary">
            Transfer ownership
          </h2>
          <p className="text-[13px] text-neutral-text-secondary mt-1 leading-snug">
            Transfer workspace ownership to another active member. You will be demoted to Admin
            after the transfer.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="new-owner" className="sr-only">
              New owner
            </label>
            <select
              id="new-owner"
              value={newOwnerId}
              onChange={(e) => setNewOwnerId(e.target.value)}
              disabled={transfer.isPending || transferCandidates.length === 0}
              className="h-8 px-2 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-60"
            >
              <option value="">
                {transferCandidates.length === 0 ? 'No eligible members' : 'Select a member…'}
              </option>
              {transferCandidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.role}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onTransfer}
              disabled={!newOwnerId || transfer.isPending}
              className="shrink-0 px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary"
            >
              {transfer.isPending ? 'Transferring…' : 'Transfer ownership…'}
            </button>
          </div>
        </div>

        {/* Delete — critical zone ------------------------------------------ */}
        <div className="rounded-card border border-semantic-critical bg-semantic-critical-bg p-4">
          <h2 className="text-[14px] font-bold text-semantic-critical">
            Delete workspace — permanent
          </h2>
          <p className="text-[13px] text-neutral-text-secondary mt-1 mb-3 leading-snug">
            Permanently deletes this workspace and{' '}
            <strong className="text-neutral-text-primary">all</strong> of its data — every program,
            project, task, baseline, group, and member. This cannot be undone. All members lose
            access immediately.
          </p>
          <div className="rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
            <div className="text-[12px] text-neutral-text-secondary mb-2">
              To confirm, type the workspace name:
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
                aria-label="Confirm delete by typing the workspace name"
                disabled={!confirmTarget}
                className={[
                  'w-[260px] h-8 px-2.5 rounded-control border tppm-mono text-[12px] text-neutral-text-primary bg-neutral-surface-raised',
                  'placeholder:text-neutral-text-disabled',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical',
                  confirmText && !confirmed ? 'border-semantic-critical' : 'border-neutral-border',
                ].join(' ')}
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!confirmed || remove.isPending}
            onClick={onDelete}
            className={[
              'px-4 py-2 rounded-control text-[13px] font-semibold text-white bg-semantic-critical transition-opacity',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
              confirmed && !remove.isPending
                ? 'opacity-100 hover:opacity-90'
                : 'opacity-40 cursor-not-allowed',
            ].join(' ')}
          >
            {remove.isPending ? 'Deleting…' : 'Delete workspace permanently'}
          </button>
          {deleteError ? (
            <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      </div>

      {toast && (
        <div
          role={toast.variant === 'error' ? 'alert' : 'status'}
          aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
          className={[
            'fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-card border border-neutral-border text-[13px] font-medium',
            toast.variant === 'error'
              ? 'bg-semantic-critical text-white'
              : 'bg-neutral-text-primary text-white',
          ].join(' ')}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
