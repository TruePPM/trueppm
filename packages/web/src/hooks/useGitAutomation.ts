/**
 * Git-event board automation config hooks (issue 1257, backend issue 329 / ADR-0158).
 *
 * Project-scoped (Owner/Admin only). Three endpoints under
 * `/api/v1/integrations/projects/{id}/git-automation/`:
 *   - GET  → read the off-by-default toggle + webhook URL + whether a secret is set
 *   - PUT  → flip `enabled`
 *   - POST .../rotate-secret/ → mint a fresh secret, returned **once** (one-time
 *     reveal, mirroring the ADR-0068 API-token contract). The GET never returns
 *     the secret — only `secret_set` — so the UI must handle "set but not visible".
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';

function basePath(projectId: string): string {
  return `/integrations/projects/${projectId}/git-automation/`;
}

export function gitAutomationKey(projectId: string) {
  return ['git-automation', projectId] as const;
}

// ---------------------------------------------------------------------------
// API shapes (match GitAutomationConfigSerializer / rotate-secret response)
// ---------------------------------------------------------------------------

export interface GitAutomationConfig {
  enabled: boolean;
  secret_set: boolean;
  webhook_url: string;
  configured_by: string | null;
  secret_set_at: string | null;
  updated_at: string;
}

/** Rotate response = the one-time plaintext secret plus the webhook URL. */
export interface RotatedGitSecret {
  secret: string;
  webhook_url: string;
  secret_set_at: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Read the Git-automation config for a project (Owner/Admin only server-side). */
export function useGitAutomationConfig(projectId: string | null | undefined) {
  return useQuery<GitAutomationConfig, Error>({
    queryKey: projectId ? gitAutomationKey(projectId) : ['git-automation', 'none'],
    queryFn: async () => {
      const res = await apiClient.get<GitAutomationConfig>(basePath(projectId!));
      return res.data;
    },
    enabled: !!projectId,
    retry: false,
  });
}

/** Flip the off-by-default `enabled` toggle. */
export function useUpdateGitAutomation(projectId: string) {
  const qc = useQueryClient();
  return useMutation<GitAutomationConfig, Error, { enabled: boolean }>({
    mutationFn: async (body) => {
      const res = await apiClient.put<GitAutomationConfig>(basePath(projectId), body);
      return res.data;
    },
    // The PUT returns the full config; seed the cache so the toggle reflects the
    // server truth immediately, then invalidate to reconcile any drift.
    onSuccess: (data) => {
      qc.setQueryData(gitAutomationKey(projectId), data);
      void qc.invalidateQueries({ queryKey: gitAutomationKey(projectId) });
    },
  });
}

/** Mint a fresh webhook secret. The plaintext is in the result and never re-fetchable. */
export function useRotateGitAutomationSecret(projectId: string) {
  const qc = useQueryClient();
  return useMutation<RotatedGitSecret, Error, void>({
    mutationFn: async () => {
      const res = await apiClient.post<RotatedGitSecret>(`${basePath(projectId)}rotate-secret/`);
      return res.data;
    },
    // A rotation sets `secret_set` true and stamps `secret_set_at`; invalidate so
    // the config GET refetches the new "secret set on …" state.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitAutomationKey(projectId) });
    },
  });
}
