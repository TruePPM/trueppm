import { useEffect, useState } from 'react';

/**
 * Reactive browser connectivity via `navigator.onLine` + the `online`/`offline`
 * window events.
 *
 * Extracted from the pattern previously inlined in `OfflineBanner` (and copied
 * across ~15 components) so the connectivity signal has a single source of truth.
 * SSR/test-env safe: falls back to `true` (assume online) when `navigator` is
 * unavailable, which keeps optimistic UI working in non-browser render passes.
 *
 * @returns `true` when the browser reports a network connection, `false` offline.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    // Re-read on mount in case connectivity changed between the initial render
    // and effect commit.
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
