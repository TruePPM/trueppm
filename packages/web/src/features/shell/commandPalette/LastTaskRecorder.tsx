import { useEffect, useRef } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { recordLastTask } from '@/lib/lastTask';
import { useLastTaskStore } from '@/stores/lastTaskStore';

/** Persists the most recently opened drawer task for the signed-in user so the
 *  ⌘K "Log time on <last task>" action can find it (#1211). Renders nothing.
 *
 *  The in-memory store survives a SPA sign-out → sign-in (no reload), so the
 *  `opened` value that was current when the user CHANGED belongs to the previous
 *  user and is ignored; only a task opened afterwards is recorded. This covers
 *  every sign-out path (menu, session-expired banner, workspace deletion), not just
 *  the ones that clear the store. */
export function LastTaskRecorder() {
  const opened = useLastTaskStore((s) => s.opened);
  const { user } = useCurrentUser();
  const userId = user?.id;
  const prevUserId = useRef<string | undefined>(undefined);
  const ignored = useRef<unknown>(null);

  useEffect(() => {
    if (prevUserId.current !== undefined && prevUserId.current !== userId) {
      ignored.current = opened;
    }
    if (userId !== undefined) prevUserId.current = userId;
    if (userId && opened && opened !== ignored.current) recordLastTask(userId, opened);
  }, [userId, opened]);

  return null;
}
