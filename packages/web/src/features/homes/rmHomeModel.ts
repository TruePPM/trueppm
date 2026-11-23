import type { PeopleLoadReason, PeopleLoadResponse } from '@/api/types';

/**
 * What the Resource Manager home shows above its heat map (#4770). Pure: it reads
 * the `usePeopleLoad` query state and the server's counts, and counts nothing
 * itself — `over_allocated_count` and `scope.project_count` are the server's.
 */
export type RmHomeState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty'; reason: PeopleLoadReason }
  | {
      kind: 'ready';
      overAllocated: number;
      people: number;
      projects: number;
      withheldProjects: number;
    };

export interface RmHomeQuery {
  data: PeopleLoadResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function rmHomeState({ data, isLoading, isError }: RmHomeQuery): RmHomeState {
  if (isError) return { kind: 'error' };
  if (isLoading || !data) return { kind: 'loading' };
  if (data.people.length === 0) return { kind: 'empty', reason: data.reason ?? 'no_people' };
  return {
    kind: 'ready',
    overAllocated: data.over_allocated_count,
    people: data.people.length,
    projects: data.scope.project_count,
    withheldProjects: data.scope.withheld_project_count,
  };
}

/** The one-line scope summary under the home's heading, e.g. "12 people · 4 projects". */
export function rmScopeLine(state: Extract<RmHomeState, { kind: 'ready' }>): string {
  const people = `${state.people} ${state.people === 1 ? 'person' : 'people'}`;
  const projects = `${state.projects} ${state.projects === 1 ? 'project' : 'projects'}`;
  return `${people} · ${projects}`;
}
