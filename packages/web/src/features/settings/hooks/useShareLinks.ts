import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Board share-link management hooks (#283, ADR-0245). Admin+ surface under Project
 * Settings → Sharing: list active links, mint a new one (raw token returned exactly
 * once), and revoke. The public read-only viewer these links point at is a separate,
 * unauthenticated page (features/share) that does NOT use the authenticated apiClient.
 */

export interface ShareLink {
  id: string;
  contentKind: string;
  tokenPrefix: string;
  label: string;
  showAssignees: boolean;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  isActive: boolean;
  isExpired: boolean;
}

/** Create response only — carries the one-time raw token and its relative path. */
export interface CreatedShareLink extends ShareLink {
  token: string;
  sharePath: string;
}

interface ShareLinkRaw {
  id: string;
  content_kind: string;
  token_prefix: string;
  label: string;
  show_assignees: boolean;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  is_active: boolean;
  is_expired: boolean;
}

interface CreatedShareLinkRaw extends ShareLinkRaw {
  token: string;
  share_path: string;
}

function mapLink(raw: ShareLinkRaw): ShareLink {
  return {
    id: raw.id,
    contentKind: raw.content_kind,
    tokenPrefix: raw.token_prefix,
    label: raw.label,
    showAssignees: raw.show_assignees,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    revokedAt: raw.revoked_at,
    accessCount: raw.access_count,
    lastAccessedAt: raw.last_accessed_at,
    isActive: raw.is_active,
    isExpired: raw.is_expired,
  };
}

function shareLinksKey(projectId: string) {
  return ['share-links', projectId] as const;
}

/** GET /projects/{id}/share-links/ — the project's active (non-revoked) links. */
export function useShareLinks(projectId: string, enabled = true) {
  return useQuery({
    queryKey: shareLinksKey(projectId),
    enabled: enabled && Boolean(projectId),
    queryFn: async () => {
      const res = await apiClient.get<ShareLinkRaw[]>(`/projects/${projectId}/share-links/`);
      return res.data.map(mapLink);
    },
  });
}

export interface CreateShareLinkInput {
  label?: string;
  showAssignees?: boolean;
  /** 'board' | 'schedule' — which view the link exposes. Defaults to board. */
  contentKind?: string;
  /** ISO timestamp for auto-expiry, or null/undefined for a link that never expires. */
  expiresAt?: string | null;
}

/** POST /projects/{id}/share-links/ — mint a link; returns the raw token once. */
export function useCreateShareLink(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateShareLinkInput) => {
      const res = await apiClient.post<CreatedShareLinkRaw>(
        `/projects/${projectId}/share-links/`,
        {
          label: input.label ?? '',
          show_assignees: input.showAssignees ?? false,
          content_kind: input.contentKind ?? 'board',
          expires_at: input.expiresAt ?? null,
        },
      );
      const raw = res.data;
      return { ...mapLink(raw), token: raw.token, sharePath: raw.share_path } as CreatedShareLink;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareLinksKey(projectId) });
    },
  });
}

/** POST /projects/{id}/share-links/{linkId}/revoke/ — revoke a link (idempotent). */
export function useRevokeShareLink(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (linkId: string) => {
      await apiClient.post(`/projects/${projectId}/share-links/${linkId}/revoke/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareLinksKey(projectId) });
    },
  });
}
