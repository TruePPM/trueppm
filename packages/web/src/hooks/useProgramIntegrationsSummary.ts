/**
 * Hook for the Program → Settings → Integrations page (ADR-0076 extension, #569).
 *
 * Mirrors useProjectIntegrationsSummary but scoped to a program. Returns the
 * program-scoped outbound webhooks and inbound API tokens — project-scoped
 * resources of child projects are NOT bubbled up; they live on their own
 * per-project pages.
 *
 * Shape and per-section 503 fallback contract are identical to the project hook.
 */

import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { apiClient } from '@/api/client';
import type {
  IntegrationsSummary,
  IntegrationsSummarySection,
  UseIntegrationsSummaryResult,
} from './useProjectIntegrationsSummary';

/**
 * GET /api/v1/programs/{id}/integrations-summary/ — program-scoped aggregator.
 *
 * Returns ``failedSection`` non-null when the server responded 503 with a
 * ``failed`` body. Other fields populate normally so other sections continue
 * to render with their data.
 */
export function useProgramIntegrationsSummary(
  programId: string | undefined,
): UseIntegrationsSummaryResult {
  const query = useQuery({
    queryKey: ['program-integrations-summary', programId],
    queryFn: async (): Promise<IntegrationsSummary> => {
      const res = await apiClient.get<IntegrationsSummary>(
        `/programs/${programId}/integrations-summary/`,
      );
      return res.data;
    },
    enabled: !!programId,
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
