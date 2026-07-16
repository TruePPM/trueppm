import { toast } from '@/components/Toast';
import {
  useTrashedProjects,
  useRestoreProject,
  type TrashProject,
} from '@/hooks/useProjectMutations';
import { InboxIcon } from '@/components/Icons';
import { EmptyState } from '@/components/EmptyState';
import { SettingsShell, SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { buildWorkspaceNavGroups } from './workspaceNav';

/**
 * Workspace > Trash (issue 1113, ADR-0202).
 *
 * Lists the caller's soft-deleted projects still inside the retention window, each with
 * a Restore action. Any member sees their team's trashed projects; Restore is enabled
 * only for the project Owner (`can_restore` from the API). Pairs with the inline
 * "Deleted — Undo" toast fired right after a delete — this page is the durable recovery
 * surface for a delete the user didn't (or couldn't) undo in the moment.
 */

// Trash is an off-route shell, so the rail deep-links config sections back to the
// consolidated page (`linked: true`). Fed from the shared `workspaceNav` builder so
// it stays in sync with the consolidated rail (#2013).
const NAV_GROUPS = buildWorkspaceNavGroups({ linked: true });

/** "3 days ago" / "today" from an ISO timestamp. */
function relativeDaysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function DeletedMeta({ project }: { project: TrashProject }) {
  const who = project.deleted_by_name ? `Deleted by ${project.deleted_by_name}` : 'Deleted';
  const when = project.deleted_at ? ` · ${relativeDaysAgo(project.deleted_at)}` : '';
  const urgent = project.days_remaining !== null && project.days_remaining <= 3;
  return (
    <p className="text-[12px] text-neutral-text-secondary">
      {who}
      {when}
      {project.deleted_at === null ? (
        ' · retained indefinitely'
      ) : project.days_remaining !== null ? (
        <>
          {' · '}
          <span className={urgent ? 'font-medium text-semantic-warning' : undefined}>
            auto-deletes in {project.days_remaining}{' '}
            {project.days_remaining === 1 ? 'day' : 'days'}
            {urgent ? ' ⚠' : ''}
          </span>
        </>
      ) : null}
    </p>
  );
}

function TrashRow({
  project,
  onRestore,
  busy,
  error,
}: {
  project: TrashProject;
  onRestore: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[13px] font-semibold text-neutral-text-primary">
              {project.name}
            </h3>
            {project.code ? (
              <code className="rounded-chip border border-neutral-border bg-neutral-surface-sunken px-1.5 py-0.5 tppm-mono text-[11px] text-neutral-text-secondary">
                {project.code}
              </code>
            ) : null}
          </div>
          <DeletedMeta project={project} />
        </div>
        <button
          type="button"
          onClick={onRestore}
          disabled={busy || !project.can_restore}
          title={project.can_restore ? undefined : 'Only the project Owner can restore this project.'}
          className={[
            'shrink-0 rounded-control border border-neutral-border px-3 py-1.5 text-[12px] font-medium',
            'text-neutral-text-primary hover:bg-neutral-surface-sunken',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            'disabled:cursor-not-allowed disabled:border-neutral-border/55 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary',
            'max-sm:w-full',
          ].join(' ')}
        >
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WorkspaceTrashPage() {
  const { data: projects, isLoading, isError, refetch } = useTrashedProjects();
  const { data: ws } = useWorkspaceSettings();
  const restore = useRestoreProject();

  const onRestore = (project: TrashProject) => {
    restore.mutate(project.id, {
      onSuccess: () => {
        toast.success(`"${project.name}" restored`);
      },
    });
  };

  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        { scope: 'program', label: 'Program', to: null, disabledReason: 'Switch from the workspace page' },
        { scope: 'project', label: 'Project', to: null, disabledReason: 'Switch from the workspace page' },
      ]}
      contextName={ws?.name ?? 'Workspace'}
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <SettingsPageTitle
        title="Trash"
        subtitle="Recently deleted projects. Restore any project during its retention window before it is permanently purged."
      />

      <div className="max-w-[720px] space-y-3 px-4 pb-8 sm:px-6">
        {isLoading ? (
          <>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[64px] animate-pulse rounded-card border border-neutral-border bg-neutral-surface-sunken"
              />
            ))}
          </>
        ) : isError ? (
          <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-[13px] text-neutral-text-secondary">Couldn&apos;t load Trash.</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-3 rounded-control border border-neutral-border px-3 py-1.5 text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Retry
            </button>
          </div>
        ) : !projects || projects.length === 0 ? (
          <EmptyState
            className="rounded-card border border-neutral-border bg-neutral-surface-raised"
            icon={InboxIcon}
            title="Trash is empty"
            description="Deleted projects appear here and stay recoverable during the retention window."
          />
        ) : (
          projects.map((project) => {
            const isRestoringThis = restore.isPending && restore.variables === project.id;
            const rowError =
              restore.isError && restore.variables === project.id && restore.error instanceof Error
                ? restore.error.message
                : null;
            return (
              <TrashRow
                key={project.id}
                project={project}
                onRestore={() => onRestore(project)}
                busy={isRestoringThis}
                error={rowError}
              />
            );
          })
        )}
      </div>
    </SettingsShell>
  );
}
