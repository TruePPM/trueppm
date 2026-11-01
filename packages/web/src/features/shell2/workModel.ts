import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePinned } from '@/hooks/usePins';
import { usePrograms } from '@/hooks/usePrograms';
import { useProjects } from '@/hooks/useProjects';
import { programPath, projectPath } from '@/lib/refPath';

/** Where the full-page Work list lives. The rail, the phone bar and the flyout's "All work" all point here. */
export const WORK_PATH = '/work';

export interface WorkRow {
  key: string;
  label: string;
  to: string;
  indent?: boolean;
  /** Set on a program row; the tree page uses it to collapse children. */
  kind?: 'program' | 'project';
  /** The program row's key, on a project row nested under it. */
  parentKey?: string;
}

export interface WorkRowsInput {
  q: string;
  pins: ReadonlyArray<{
    kind: 'project' | 'program';
    id: string;
    name: string;
    code: string | null;
  }>;
  programs: ReadonlyArray<{ id: string; name: string; code?: string | null }>;
  projects: ReadonlyArray<{ id: string; name: string; code?: string; programId: string | null }>;
}

/**
 * The pinned, program and project rows the Work flyout AND the full-page Work
 * list show, already filtered by `q`. One function feeds both surfaces so their
 * data, filtering and ordering cannot drift: pins first, then each program with
 * its matching projects, then standalone projects. A program stays when only a
 * child matches; a matching program with no matching child shows alone.
 */
export function workRows(input: WorkRowsInput): { pinned: WorkRow[]; programs: WorkRow[] } {
  const needle = input.q.trim().toLowerCase();
  const matches = (name: string) => needle === '' || name.toLowerCase().includes(needle);
  const pinned = input.pins
    .filter((p) => matches(p.name))
    .map((p) => ({
      key: `pin:${p.kind}:${p.id}`,
      label: p.name,
      to:
        p.kind === 'program'
          ? programPath({ id: p.id, code: p.code }, 'overview')
          : projectPath({ id: p.id, code: p.code }, 'overview'),
    }));
  const programs: WorkRow[] = [];
  for (const program of input.programs) {
    const children = input.projects.filter((pr) => pr.programId === program.id && matches(pr.name));
    if (!matches(program.name) && children.length === 0) continue;
    const key = `program:${program.id}`;
    programs.push({
      key,
      label: program.name,
      to: programPath(program, 'overview'),
      kind: 'program',
    });
    for (const pr of children) {
      programs.push({
        key: `project:${pr.id}`,
        label: pr.name,
        to: projectPath(pr, 'overview'),
        indent: true,
        kind: 'project',
        parentKey: key,
      });
    }
  }
  const standalone = input.projects.filter((pr) => pr.programId === null && matches(pr.name));
  for (const pr of standalone) {
    programs.push({
      key: `project:${pr.id}`,
      label: pr.name,
      to: projectPath(pr, 'overview'),
      kind: 'project',
    });
  }
  return { pinned, programs };
}

/**
 * Reads pins, programs and projects and returns the filtered rows plus the
 * loading/failed state. The only hook either Work surface calls for data.
 */
export function useWorkModel(q: string) {
  const queryClient = useQueryClient();
  const { data: pins } = usePinned();
  const programsQuery = usePrograms();
  const projectsQuery = useProjects();
  const rows = useMemo(
    () =>
      workRows({
        q,
        pins: pins ?? [],
        programs: programsQuery.data ?? [],
        projects: projectsQuery.data ?? [],
      }),
    [q, pins, programsQuery.data, projectsQuery.data],
  );
  const refetch = () => {
    void programsQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  return {
    rows,
    loading: programsQuery.isLoading || projectsQuery.isLoading,
    failed: Boolean(programsQuery.error ?? projectsQuery.error),
    refetch,
    /** True when the person has no programs and no projects at all (not merely a filter with no hits). */
    isEmpty: (programsQuery.data?.length ?? 0) === 0 && (projectsQuery.data?.length ?? 0) === 0,
  };
}
