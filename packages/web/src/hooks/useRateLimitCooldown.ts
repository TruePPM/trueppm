import { useCallback, useEffect, useState } from 'react';
import { isRateLimited, retryAfterSeconds } from '@/lib/rateLimit';

/**
 * Cooldown after a 429 (#2432, #3563). `start(err)` begins a countdown from the
 * server's `Retry-After` (falling back to `fallbackSeconds`) and returns whether
 * `err` was a 429 at all, so a caller can branch its generic-error path on it.
 * `waitSeconds` is the wait as first announced (stable, so a live region does not
 * re-announce every tick); `remaining` ticks down once a second; `active` is the signal to disable the
 * triggering control so a user is not left clicking a button that will refuse again.
 */
export function useRateLimitCooldown(fallbackSeconds = 10): {
  active: boolean;
  remaining: number;
  waitSeconds: number;
  start: (err: unknown) => boolean;
  clear: () => void;
} {
  const [until, setUntil] = useState<number | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const start = useCallback(
    (err: unknown) => {
      if (!isRateLimited(err)) return false;
      const t = Date.now();
      setNow(t);
      const wait = retryAfterSeconds(err) ?? fallbackSeconds;
      setWaitSeconds(wait);
      setUntil(t + wait * 1000);
      return true;
    },
    [fallbackSeconds],
  );

  const clear = useCallback(() => setUntil(null), []);

  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) setUntil(null);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  const remaining = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  return { active: until !== null && remaining > 0, remaining, waitSeconds, start, clear };
}
