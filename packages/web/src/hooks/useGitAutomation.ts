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

/**
 * Outcome of the most recent inbound delivery (#2882).
 *
 * Deliberately a plain `string`, not a union: the server owns this vocabulary and
 * grows it with the event taxonomy, so a narrowed union here would make an
 * API-side addition a compile error in the client and — worse — tempt an
 * exhaustive `switch` that renders nothing for a value it has never seen. The
 * known tokens are:
 *
 * - `last_refusal_outcome` — refused before the signature check, so the caller saw
 *   only an opaque 404 and an admin reading this row is the sole way to tell which it
 *   was: `automation_disabled`, `no_secret`, `unknown_provider`, `secret_unreadable`,
 *   `bad_signature`. (`no_automation` is NOT among them: that refusal has no config
 *   row to write to, so it reaches the server log only.)
 * - `last_delivery_outcome` — verified, then not acted on: `malformed_payload`,
 *   `ignored`, `draft`, `duplicate`, `no_url`, `no_link`, `noop_forward_only`
 * - `last_delivery_outcome` — a card moved: `opened_review`, `merged_complete`
 */
export type GitDeliveryOutcome = string;

export interface GitAutomationConfig {
  enabled: boolean;
  secret_set: boolean;
  webhook_url: string;
  configured_by: string | null;
  secret_set_at: string | null;
  updated_at: string;
  /**
   * Delivery diagnostics. Optional in the type, not because the server omits them,
   * but because an older API build does — and the card has to degrade to its previous
   * "no information" state rather than render `undefined`.
   *
   * `last_delivery_*` and `last_refusal_*` are two independent slots, and the split
   * is a server-side security property the client must preserve: a refusal is
   * recorded before the signature is verified, so anyone holding the project ID can
   * write one. Rendering them in one row would let a stranger overwrite a genuine
   * diagnosis — and, for `bad_signature`, prompt an admin to rotate a working secret.
   */
  last_delivery_at?: string | null;
  last_delivery_outcome?: GitDeliveryOutcome;
  last_delivery_provider?: string;
  last_refusal_at?: string | null;
  last_refusal_outcome?: GitDeliveryOutcome;
  last_refusal_provider?: string;
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
