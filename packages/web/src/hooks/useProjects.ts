import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Project } from '@/types';
import type { PaginatedResponse } from '@/api/types';

export interface UseProjectsResult {
  data: Project[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string;
}

// Deterministic palette cycled by index — no server-side color assignment yet.
// Values are Design System hex literals kept here as the canonical definition
// (components must not reference this array directly — they consume Project.colorDot).
const COLOR_PALETTE: ReadonlyArray<string> = [
  '#1C6B3A',
  '#E8A020',
  '#B91C1C',
  '#6B6965',
  '#145229',
  '#1D4ED8',
  '#7C3AED',
  '#0E7490',
];

function mapProject(p: ApiProject, index: number): Project {
  return {
    id: p.id,
    name: p.name,
    // healthState is not computed server-side yet; default to unknown
    healthState: 'unknown',
    // The modulo guarantees index is in bounds; fallback keeps TS happy on the readonly array type
    colorDot: COLOR_PALETTE[index % COLOR_PALETTE.length] ?? '#1C6B3A',
  };
}

/**
 * GET /api/v1/projects/ — fetch the current user's project list.
 *
 * Suppresses error state during the 401→token-refresh→retry cycle to prevent
 * a "Failed to load" flash while the interceptor silently retries the request.
 * colorDot is assigned client-side from a deterministic palette (no server color).
 */
export function useProjects(): UseProjectsResult {
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiProject>>('/projects/');
      return res.data.results.map(mapProject);
    },
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    // Suppress transient errors during the 401→token-refresh→retry cycle:
    // the axios interceptor retries transparently, so query.isFetching is true
    // while the retry is in flight. Showing an error during that window causes
    // a visible "Failed to load projects" flash even though the retry succeeds.
    error: query.isError && !query.isFetching ? query.error : null,
  };
}
