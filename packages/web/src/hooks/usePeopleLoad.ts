import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PeopleLoadResponse } from '@/api/types';

/** Default range of the load heat map, in weeks. Matches the server default. */
export const PEOPLE_LOAD_WEEKS = 8;

/**
 * GET /api/v1/me/people-load/ — each person's weekly load across the viewer's
 * projects (#4777). The People destination and the Resource Manager home share
 * this one query key, so the two surfaces read one payload and cannot disagree.
 */
export function usePeopleLoad(weeks: number = PEOPLE_LOAD_WEEKS) {
  return useQuery({
    queryKey: ['people-load', weeks],
    queryFn: async () => {
      const res = await apiClient.get<PeopleLoadResponse>('/me/people-load/', {
        params: { weeks },
      });
      return res.data;
    },
    staleTime: 60_000,
  });
}
