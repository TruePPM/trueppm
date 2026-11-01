import { useEffect, useRef } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { recordLastTask } from '@/lib/lastTask';
import { useLastTaskStore } from '@/stores/lastTaskStore';

/** Persists the most recently opened drawer task for the signed-in user so the
 *  ⌘K "Log time on <last task>" action can find it (#1211). Renders nothing.
 *
 *  The in-memory store outlives this component, so the previous user's task must
 *  not reach the next user's key. The primary guard is in `authStore`
 *  (`clearTokens` / `markSessionExpired` empty the store, and they cover every
 *  sign-out path even though the shell unmounts). The ref guard below is a second
 *  line for a user switch while this instance stays mounted: the `opened` value
 *  current at that moment is ignored. */
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
