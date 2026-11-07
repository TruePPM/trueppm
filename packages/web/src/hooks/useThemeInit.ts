import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { editionQueryOptions } from '@/hooks/useEdition';
import { hasStoredTheme, useThemeStore } from '@/stores/themeStore';

/**
 * Applies and maintains the .dark class on <html> based on the stored theme
 * preference. In 'auto' mode, follows prefers-color-scheme and reacts to
 * system-level changes without a page reload.
 *
 * Call once at the top of the React tree (App component). The index.html
 * inline script handles the pre-React flash prevention.
 */
export function useThemeInit(): void {
  const theme = useThemeStore((s) => s.theme);
  // App sits above the QueryClientProvider, so pass the shared client explicitly; this
  // reads the same ['edition'] entry useDemoMode does.
  const { data: edition } = useQuery(editionQueryOptions, queryClient);
  const isDemo = edition?.demo_read_only === true;

  // The hosted demo defaults to light so a dark-OS visitor is not greeted by dark.
  // Applied to the store only (never written to localStorage): a default is not a
  // choice, so an explicit stored value always wins and the toggle still works.
  // Known limitation: this runs only after /edition/ resolves, and the blocking
  // public/theme-init.js has already added .dark for a dark-OS visitor with nothing
  // stored, so first paint can flash dark; since the default is never persisted it
  // recurs on each visit.
  useEffect(() => {
    if (isDemo && !hasStoredTheme()) {
      useThemeStore.setState({ theme: 'light' });
    }
  }, [isDemo]);

  useEffect(() => {
    const html = document.documentElement;

    if (theme === 'dark') {
      html.classList.add('dark');
      return;
    }

    if (theme === 'light') {
      html.classList.remove('dark');
      return;
    }

    // auto — mirror prefers-color-scheme and stay in sync with OS changes
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => html.classList.toggle('dark', mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
