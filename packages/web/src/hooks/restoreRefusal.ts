import axios from 'axios';

/**
 * The sentence to show when a task restore is refused, or `null` for anything else.
 *
 * `POST /tasks/:id/restore/` answers **409** when the task's WBS position was given to
 * another live task while it sat in the trash (#3071). Retrying can never clear that —
 * the occupant has to move first — so the generic "try again" copy is actively wrong
 * here, and the server's `detail` already names the occupying task.
 *
 * **Its own module, deliberately, rather than an export of `useTaskMutations`.** That
 * module is mocked by 35 test files, most with factories that list the few exports the
 * file under test needs; under `fileParallelism: false` (one forked process for the
 * whole suite) such a factory shadows the real module for *later* files too, so a
 * component calling a newly-added export gets `undefined` — in a spec that passes on
 * its own and fails only in the shard that happens to run the two together. A pure
 * function has no reason to live behind a hooks module anyway.
 */
export function restoreRefusalMessage(error: unknown): string | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data = error.response.data as { detail?: unknown; code?: unknown } | undefined;
  if (data?.code !== 'wbs_path_occupied') return null;
  return typeof data.detail === 'string' ? data.detail : null;
}
