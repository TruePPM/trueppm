import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useProjects } from '@/hooks/useProjects';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import type { CommandItem } from './commandItems';
import { buildCrossProjectViewItems } from './searchRanking';

/** "Sprints — Platform Core" rows for the palette's no-match state (#4504). Inert
 *  (empty) unless the palette is open with a query; reads the shared projects
 *  query, so no extra request. */
export function useCrossProjectViewItems(enabled: boolean, query: string): CommandItem[] {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  return useMemo(() => {
    if (!enabled) return [];
    const go = (path: string) => () => {
      setOpen(false);
      void navigate(path);
    };
    return buildCrossProjectViewItems(projects, query, go);
  }, [enabled, projects, query, navigate, setOpen]);
}
