/**
 * Hook for the Project → Settings → Integrations page (ADR-0076, #569).
 *
 * Fetches the project's outbound webhooks (ADR-0019) and inbound API tokens
 * (ADR-0068) in a single round-trip via the integrations-summary aggregator.
 *
 * The aggregator returns 503 with a `{"failed": "<section>"}` body when one
 * subservice errors. Callers can use the `failedSection` field to render the
 * per-section retry contract from ADR-0076 (other sections continue to render
 * from cached data; the failed section shows a Retry button that re-fetches
 * the underlying viewset directly).
 */

import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { apiClient } from '@/api/client';

export type IntegrationsSummarySection = 'webhooks' | 'api_tokens';

export interface WebhookSummaryItem {
  id: string;
  url: string;
  is_active: boolean;
  events: string[];
  created_at: string;
  last_delivery: {
    status: 'pending' | 'success' | 'failed';
    created_at: string;
    response_status: number | null;
    attempt_count: number;
  } | null;
  recent_failure_count: number;
}

export interface ApiTokenSummaryItem {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface IntegrationsSummary {
  webhooks: {
    items: WebhookSummaryItem[];
    total: number;
    active_total: number;
    last_delivery_at: string | null;
  };
  api_tokens: {
    items: ApiTokenSummaryItem[];
    active_total: number;
    last_used_at: string | null;
  };
}

export interface UseIntegrationsSummaryResult {
  summary: IntegrationsSummary | undefined;
  isLoading: boolean;
  error: Error | null;
  failedSection: IntegrationsSummarySection | null;
  refetch: () => Promise<unknown>;
}

/**
 * GET /api/v1/projects/{id}/integrations-summary/ — project-scoped aggregator.
 *
 * Returns `failedSection` non-null when the server responded 503 with a
 * `failed` body. Other fields (summary, error) are populated normally.
 */
export function useProjectIntegrationsSummary(
  projectId: string | undefined,
): UseIntegrationsSummaryResult {
  const query = useQuery({
    queryKey: ['project-integrations-summary', projectId],
    queryFn: async (): Promise<IntegrationsSummary> => {
      const res = await apiClient.get<IntegrationsSummary>(
        `/projects/${projectId}/integrations-summary/`,
      );
      return res.data;
    },
    enabled: !!projectId,
    // Integrations state changes infrequently — webhooks fire async; tokens
    // are minted once. Mirror useProjectMembers' 5-minute cache.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  let failedSection: IntegrationsSummarySection | null = null;
  if (isAxiosError(query.error) && query.error.response?.status === 503) {
    const body = query.error.response.data as { failed?: string } | undefined;
    if (body?.failed === 'webhooks' || body?.failed === 'api_tokens') {
      failedSection = body.failed;
    }
  }

  return {
    summary: query.data,
    isLoading: query.isLoading,
    error: query.error,
    failedSection,
    refetch: query.refetch,
  };
}
