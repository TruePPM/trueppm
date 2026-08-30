import axios from 'axios';

/**
 * The sentence to show when committing a plan is refused, or `null` for anything else.
 *
 * `POST /projects/:id/commit/` answers **409** `already_committed` when the project has
 * already left draft — most often because a second admin committed it while this
 * dialog was open (#3129). Retrying can never clear that: `commit_project()` refuses a
 * non-draft project by design, because a second commit would capture a second "v1" and
 * move the anchor every variance number is measured from. So the generic "try again"
 * copy is actively wrong here, and the caller should also refetch the project — the
 * Commit affordance itself is now stale and must disappear rather than keep offering
 * an action the server will never accept.
 *
 * **Its own module, deliberately, rather than an export of `useProjectMutations`** —
 * for the reason spelled out in `restoreRefusal.ts`: that module is mocked by many test
 * files whose factories list only the exports the file under test needs, and under
 * `fileParallelism: false` such a factory shadows the real module for later files too,
 * so a component calling a newly-added export gets `undefined` in a spec that passes
 * alone and fails only in the shard that runs the two together.
 */
export function commitRefusalMessage(error: unknown): string | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data = error.response.data as { detail?: unknown; code?: unknown } | undefined;
  if (data?.code !== 'already_committed') return null;
  return typeof data.detail === 'string' ? data.detail : null;
}
