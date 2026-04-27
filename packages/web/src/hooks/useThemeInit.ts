import { useEffect } from 'react';
import { useThemeStore } from '@/stores/themeStore';

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
