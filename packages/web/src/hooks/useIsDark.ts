import { useEffect, useState } from 'react';
import { useThemeStore } from '@/stores/themeStore';

/**
 * Returns a reactive boolean that is true when the active colour scheme is dark.
 *
 * In 'auto' mode, subscribes to prefers-color-scheme changes so canvas renderers
 * (which cannot read CSS custom properties) re-paint when the OS preference flips
 * without a page reload. 'light' and 'dark' are straightforward.
 */
export function useIsDark(): boolean {
  const theme = useThemeStore((s) => s.theme);

  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    // Sync in case the preference changed between render and effect.
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemDark;
}
