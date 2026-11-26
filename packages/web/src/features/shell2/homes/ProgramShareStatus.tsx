import { useState } from 'react';
import { isAxiosError } from 'axios';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { toast } from '@/components/Toast/toast';
import { FOCUS_RING } from '@/components/page2/classes';
import {
  useRevokeShareLink,
  useShareLinks,
  type ShareLink,
} from '@/features/settings/hooks/useShareLinks';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import type { ProjectRow } from './programHomeModel';

const KIND_LABEL: Record<string, string> = {
  board: 'Board',
  schedule: 'Schedule',
  status_update: 'Status update',
};

const BTN = `inline-flex min-h-[44px] items-center rounded-md border border-p1-hairline bg-p1-surface-1 px-3 text-sm text-p1-text-1 hover:bg-p1-surface-2 disabled:opacity-60 ${FOCUS_RING}`;

/**
 * Executive home share status (#4771): which public links are live on each project of
 * the SELECTED program, with a revoke. It reads and writes through the existing
 * `ShareLink` endpoints (the same hooks as Project Settings → Sharing); nothing here
 * adds a model, an endpoint or a cross-program scope.
 */
export function ProgramShareStatus({ rows }: { rows: ProjectRow[] }) {
  return (
    <section aria-labelledby="home-share" className="flex flex-col gap-2">
      <h2 id="home-share" className="text-sm font-semibold text-p1-text-1">
        Share status
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-p1-text-2">This program has no projects to share yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <ProjectShareRow key={r.id} project={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectShareRow({ project }: { project: ProjectRow }) {
  const q = useShareLinks(project.id);
  const active = (q.data ?? []).filter((l) => l.isActive);
  return (
    <li className="rounded-lg border border-p1-hairline bg-p1-surface-1 px-4 py-2">
      <p className="m-0 text-sm font-medium text-p1-text-1">{project.name}</p>
      {q.isLoading ? (
        <LoadingSkeleton label={`Loading share links for ${project.name}…`} rows={1} />
      ) : q.error ? (
        isAxiosError(q.error) && q.error.response?.status === 403 ? (
          <p className="m-0 text-sm text-p1-text-2">
            Share links are visible to project admins only.
          </p>
        ) : (
          <QueryErrorState
            variant="inline"
            message="Couldn't load share links."
            onRetry={() => void q.refetch()}
          />
        )
      ) : active.length === 0 ? (
        <p className="m-0 text-sm text-p1-text-2">Not shared.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {active.map((l) => (
            <LinkRow key={l.id} projectId={project.id} projectName={project.name} link={l} />
          ))}
        </ul>
      )}
    </li>
  );
}

function LinkRow({
  projectId,
  projectName,
  link,
}: {
  projectId: string;
  projectName: string;
  link: ShareLink;
}) {
  const revoke = useRevokeShareLink(projectId);
  const [confirming, setConfirming] = useState(false);
  const kind = KIND_LABEL[link.contentKind] ?? link.contentKind;
  const name = link.label || `${kind} link ${link.tokenPrefix}`;
  const meta = [
    kind,
    link.expiresAt ? `expires ${fmtUtcShort(link.expiresAt)}` : 'never expires',
    `${link.accessCount} ${link.accessCount === 1 ? 'view' : 'views'}`,
  ].join(' · ');
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-p1-hairline py-1 first:border-t-0">
      <span className="min-w-0 text-sm text-p1-text-1">
        <span className="font-medium">{name}</span>
        <span className="block text-xs text-p1-text-2">{meta}</span>
      </span>
      {confirming ? (
        <span className="flex gap-2" role="group" aria-label={`Revoke ${name}`}>
          <button
            type="button"
            className={BTN}
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(link.id, {
                onError: () => toast.error("Couldn't revoke the link. Try again."),
                onSettled: () => setConfirming(false),
              })
            }
          >
            Revoke link
          </button>
          <button type="button" className={BTN} onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={BTN}
          aria-label={`Revoke ${name} on ${projectName}`}
          onClick={() => setConfirming(true)}
        >
          Revoke
        </button>
      )}
    </li>
  );
}
