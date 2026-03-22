// Stub hook — returns fixture data until real API hooks are wired in.
// Replace the body with a real useQuery call; the return type is stable.
import { FIXTURE_PROJECTS } from '@/fixtures/projects';
import type { Project } from '@/types';

export interface UseProjectsResult {
  data: Project[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useProjects(): UseProjectsResult {
  return { data: FIXTURE_PROJECTS, isLoading: false, error: null };
}
