import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { StatusUpdate } from '@/api/types';
import type { Rag } from '@/lib/ragBand';

interface StatusUpdatePage {
  count: number;
  next: string | null;
  previous: string | null;
  results: StatusUpdate[];
}

/** TanStack key for a project's status-update history (newest first, first page). */
export const statusUpdatesKey = (projectId: string) => ['status-updates', projectId] as const;

/**
 * A project's posted status updates, newest first, each with its frozen snapshot
 * and the API's live diff (#4803). The first page (20) is the history the Overview
 * shows; older updates are not paged in yet.
 */
export function useStatusUpdates(projectId: string) {
  return useQuery<StatusUpdatePage>({
    queryKey: statusUpdatesKey(projectId),
    queryFn: async () =>
      (await apiClient.get<StatusUpdatePage>(`/projects/${projectId}/status-updates/`)).data,
  });
}

/**
 * Posts the PM's call. Not optimistic: the snapshot is frozen by the server at
 * post time, so there is nothing truthful to show before the response. On success
 * the history is refetched so the new row carries the server's snapshot.
 */
export function usePostStatusUpdate(projectId: string) {
  const qc = useQueryClient();
  return useMutation<
    StatusUpdate,
    unknown,
    { rag: Rag; narrative: string; idempotencyKey: string }
  >({
    // The key makes a retry of a post that committed but lost its response replay the
    // stored result instead of minting a second, uneditable update.
    mutationFn: async ({ idempotencyKey, ...body }) =>
      (
        await apiClient.post<StatusUpdate>(`/projects/${projectId}/status-updates/`, body, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: statusUpdatesKey(projectId) }),
  });
}

/** Page sizes the PDF endpoint renders (#4805). */
export type StatusUpdatePdfSize = 'letter' | 'a4';

/** The file name a downloaded PDF is saved under. */
export function statusUpdatePdfFilename(
  seq: number,
  size: StatusUpdatePdfSize,
  code?: string | null,
): string {
  const safe = (code ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'project';
  return `${safe}-status-update-${seq}-${size}.pdf`;
}

/**
 * Download one update's one-page PDF (#4805). The endpoint needs the session, so the
 * file is fetched through `apiClient` as a blob and saved client-side: a plain anchor
 * `href` would reach it unauthenticated. The server draws it from the frozen snapshot.
 */
export async function downloadStatusUpdatePdf(
  projectId: string,
  update: Pick<StatusUpdate, 'id' | 'seq'>,
  size: StatusUpdatePdfSize,
  code?: string | null,
): Promise<void> {
  const res = await apiClient.get<Blob>(`/projects/${projectId}/status-updates/${update.id}/pdf/`, {
    params: { size },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = statusUpdatePdfFilename(update.seq, size, code);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred: some browsers start the download after click() returns, and a URL
  // revoked in the same tick saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** What the one-time mint returns that the row shows: the raw token's path, once. */
export interface StatusUpdateShareLink {
  id: string;
  share_path: string;
  expires_at: string | null;
}

export interface StatusUpdateShareInput {
  updateId: string;
  /** Days until the link stops resolving. Every status-update link expires. */
  expiresInDays: number;
  showRisks: boolean;
  showDecisions: boolean;
}

/**
 * Mint a read-only share link bound to ONE posted update (#4803 API, #4805 action).
 * People's names stay off (the server default); risks and decisions are opt-in. The
 * token is returned once and never stored by the client beyond the reveal.
 */
export function useCreateStatusUpdateShareLink(projectId: string) {
  return useMutation<StatusUpdateShareLink, unknown, StatusUpdateShareInput>({
    mutationFn: async ({ updateId, expiresInDays, showRisks, showDecisions }) =>
      (
        await apiClient.post<StatusUpdateShareLink>(`/projects/${projectId}/share-links/`, {
          content_kind: 'status_update',
          status_update: updateId,
          expires_at: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
          show_risks: showRisks,
          show_decisions: showDecisions,
        })
      ).data,
  });
}
