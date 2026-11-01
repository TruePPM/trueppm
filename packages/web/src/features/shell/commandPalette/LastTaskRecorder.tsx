import { useEffect } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { recordLastTask } from '@/lib/lastTask';
import { useLastTaskStore } from '@/stores/lastTaskStore';

/** Persists the most recently opened drawer task for the signed-in user so the
 *  ⌘K "Log time on <last task>" action can find it (#1211). Renders nothing. */
export function LastTaskRecorder() {
  const opened = useLastTaskStore((s) => s.opened);
  const { user } = useCurrentUser();
  const userId = user?.id;

  useEffect(() => {
    if (userId && opened) recordLastTask(userId, opened);
  }, [userId, opened]);

  return null;
}
