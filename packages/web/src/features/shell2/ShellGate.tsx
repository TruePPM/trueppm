import { useFeatureFlag } from '@/lib/featureFlags';
import { AppShell } from '@/features/shell/AppShell';
import { AppShell2 } from './AppShell2';

import { SHELL_V2_FLAG } from './shellFlag';

export { SHELL_V2_FLAG };

/**
 * Mounts shell v2 when the flag is on, the v1 shell otherwise. The two shells
 * share the whole route tree beneath them, so flipping the flag is a chrome
 * change only — no page moves, no URL changes.
 */
export function ShellGate() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  return v2 ? <AppShell2 /> : <AppShell />;
}
