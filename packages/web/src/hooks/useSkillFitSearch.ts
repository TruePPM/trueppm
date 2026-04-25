/**
 * GET /api/v1/resources/?search=&task= — returns resources annotated with
 * skill_fit (exact | partial | missing) when a taskId is provided.
 * Results are pre-sorted server-side: exact → partial → missing.
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Proficiency, ResourceWithSkillFit } from '@/types';

interface ApiResourceSkillFit {
  id: string;
  name: string;
  email: string;
  job_role: string;
  max_units: string;
  calendar: string | null;
  skills: Array<{
    id: string;
    resource: string;
    skill: string;
    skill_name: string;
    proficiency: Proficiency;
  }>;
  skill_fit?: 'exact' | 'partial' | 'missing';
  missing_skills?: Array<{
    skill_id: string;
    skill_name: string;
    required: Proficiency;
    required_label: string;
    actual: number;
    actual_label: string;
  }>;
}

function mapResource(r: ApiResourceSkillFit): ResourceWithSkillFit {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    jobRole: r.job_role,
    maxUnits: parseFloat(r.max_units),
    calendarId: r.calendar,
    skills: r.skills.map((s) => ({
      id: s.id,
      resourceId: s.resource,
      skillId: s.skill,
      skill: { id: s.skill, name: s.skill_name, normalizedName: '', category: '' },
      proficiency: s.proficiency,
    })),
    skillFit: r.skill_fit ?? 'missing',
    missingSkills: (r.missing_skills ?? []).map((ms) => ({
      skillId: ms.skill_id,
      skillName: ms.skill_name,
      required: ms.required,
      requiredLabel: ms.required_label,
      actual: ms.actual,
      actualLabel: ms.actual_label,
    })),
  };
}

interface SkillFitGroups {
  exact: ResourceWithSkillFit[];
  partial: ResourceWithSkillFit[];
  missing: ResourceWithSkillFit[];
}

export function useSkillFitSearch(query: string, taskId: string) {
  return useQuery({
    queryKey: ['resources', 'skill-fit', taskId, query],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiResourceSkillFit>>('/resources/', {
        params: { search: query, task: taskId },
      });
      const resources = res.data.results.map(mapResource);
      const groups: SkillFitGroups = { exact: [], partial: [], missing: [] };
      for (const r of resources) {
        groups[r.skillFit].push(r);
      }
      return groups;
    },
    enabled: Boolean(taskId),
    staleTime: 30_000,
  });
}
