import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useShellStore } from '@/stores/shellStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import type { CommandItem } from './commandItems';

const THEME_CYCLE: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };

/**
 * Assembles the live command-palette items from the user's real nav surface:
 * the personal destinations, every program and project they can reach, plus a
 * few global actions. Each item closes the palette before acting so focus
 * returns cleanly to the page.
 */
export function useCommandItems(): CommandItem[] {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  return useMemo(() => {
    // Wrap every action so the overlay closes first, then the effect runs.
    const act = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const go = (path: string) =>
      act(() => {
        void navigate(path);
      });

    const jumps: CommandItem[] = [
      { id: 'jump:my-work', label: 'My Work', group: 'jump', tag: 'View', run: go('/me/work') },
      { id: 'jump:inbox', label: 'Inbox', group: 'jump', tag: 'View', keywords: 'notifications', run: go('/me/notifications') },
      { id: 'jump:programs', label: 'Programs', group: 'jump', tag: 'View', run: go('/programs') },
    ];

    for (const program of programs ?? []) {
      jumps.push({
        id: `jump:program:${program.id}`,
        label: program.name,
        group: 'jump',
        tag: 'Program',
        keywords: program.code,
        run: go(`/programs/${program.id}/overview`),
      });
    }

    for (const project of projects ?? []) {
      jumps.push({
        id: `jump:project:${project.id}`,
        label: project.name,
        group: 'jump',
        tag: 'Project',
        // Overview is the one view present for every methodology — a safe default.
        run: go(`/projects/${project.id}/overview`),
      });
    }

    const actions: CommandItem[] = [
      {
        id: 'action:cycle-theme',
        label: `Switch theme (now: ${theme})`,
        group: 'action',
        tag: 'Action',
        keywords: 'dark light auto appearance',
        run: act(() => setTheme(THEME_CYCLE[theme])),
      },
      {
        id: 'action:toggle-sidebar',
        label: 'Toggle sidebar',
        group: 'action',
        tag: 'Action',
        keywords: 'collapse expand rail',
        run: act(toggleSidebar),
      },
    ];

    return [...jumps, ...actions];
  }, [navigate, programs, projects, theme, setTheme, toggleSidebar, setOpen]);
}
