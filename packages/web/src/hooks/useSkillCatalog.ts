import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Skill } from '@/types';

interface ApiSkill {
  id: string;
  name: string;
  normalized_name: string;
  category: string;
}

function mapSkill(s: ApiSkill): Skill {
  return {
    id: s.id,
    name: s.name,
    normalizedName: s.normalized_name,
    category: s.category,
  };
}

/** GET /api/v1/skills/?search= — debounced autocomplete for skill picker. */
export function useSkillCatalog(query: string) {
  return useQuery({
    queryKey: ['skills', 'search', query],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiSkill>>('/skills/', {
        params: { search: query },
      });
      return res.data.results.map(mapSkill);
    },
    staleTime: 60_000,
    enabled: query.length > 0,
  });
}

/** POST /api/v1/skills/ — create or retrieve existing by normalized_name. */
export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, category }: { name: string; category?: string }) => {
      const res = await apiClient.post<ApiSkill>('/skills/', { name, category: category ?? '' });
      return mapSkill(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}
