import { lazy, Suspense } from 'react';
import { useFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/ShellGate';

const BoardView = lazy(() => import('../BoardView').then((m) => ({ default: m.BoardView })));

/**
 * The `/board` route element: the Pass 2 board under `shell_v2`, the v1 board
 * otherwise. Only the page swaps; the route, URL and params are shared, so the
 * v1 board is byte-for-byte what it was with the flag off.
 */
export function BoardRoute() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  return <Suspense fallback={null}>{v2 ? <Board2Lazy /> : <BoardView />}</Suspense>;
}

const Board2Lazy = lazy(() => import('./Board2Page').then((m) => ({ default: m.Board2Page })));
