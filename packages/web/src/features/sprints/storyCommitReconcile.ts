import type { BulkUpdateOperation, TaskBulkResponse } from '@/hooks/useTaskMutations';

/**
 * Turning a sprint-picker selection into one `tasks/bulk` batch, and the batch's
 * 207 back into something a planner can read and act on (#2914).
 *
 * The picker used to fire one `PATCH /tasks/{id}/` per selected story through
 * `Promise.allSettled`. Those N requests are N transactions: a failure on story 14
 * of 40 left thirteen stories committed, twenty-six untouched, and no statement
 * anywhere of which was which — during a time-boxed planning ceremony, with the
 * committed-points snapshot that feeds velocity taken moments later.
 * `POST /projects/{pk}/tasks/bulk/` is one request, applied per row inside a single
 * `transaction.atomic()`, that answers exactly that question (ADR-0772, #2723).
 */

/** One story the picker sent, positioned by its index in the `operations` array. */
export interface CommittedStoryRef {
  id: string;
  name: string;
}

/** One story the server did not commit, correlated back to the row the user picked. */
export interface StoryCommitProblem {
  /**
   * Zero-based `operations` index. This — not `id` — is the batch's correlation
   * handle (ADR-0772 §2): the server may reject a row before it has an id to echo
   * back, so `id` is nullable in the response and `index` never is.
   */
  index: number;
  /** The id we sent for that index; null only if the index is unaccounted for. */
  id: string | null;
  /** Story name captured at send time, so the panel reads even after a refetch. */
  name: string;
  code: string;
  reason: string;
}

export interface StoryCommitOutcome {
  sentCount: number;
  /** Rows the server actually wrote — the committed count the picker reports. */
  committedCount: number;
  rejected: StoryCommitProblem[];
  /** Documented no-ops (`tombstoned`, `milestone_gate`) — refused, but not failures. */
  skipped: StoryCommitProblem[];
  /**
   * Exactly the ids a retry re-sends: rejected rows only. Re-sending an applied row
   * would be harmless but dishonest — the retry affordance claims to act on the rows
   * that failed, and a count that includes rows that succeeded contradicts it. A
   * skipped row is excluded for the opposite reason: the server has already decided
   * it is a no-op, so retrying it can only produce the same skip.
   */
  retryIds: string[];
  /** Every row the picker sent landed — the path that closes the modal silently. */
  isClean: boolean;
}

/**
 * Build the `operations` array for one commit batch.
 *
 * `sprint` is the write field on `TaskSerializer` (the same one the old per-row
 * PATCH sent); the bulk endpoint runs each row through that serializer, so the
 * payload shape is identical — only the transaction boundary changes.
 */
export function buildStoryCommitOperations(
  storyIds: string[],
  sprintId: string,
): BulkUpdateOperation[] {
  return storyIds.map((id) => ({ op: 'update' as const, id, data: { sprint: sprintId } }));
}

interface ProblemEntry {
  index: number;
  id: string | null;
  code: string;
  message: string;
}

function toProblem(sent: CommittedStoryRef[], entry: ProblemEntry): StoryCommitProblem {
  const row = sent[entry.index] as CommittedStoryRef | undefined;
  return {
    index: entry.index,
    // Prefer the id we sent over the one echoed back: we know it for certain, and
    // the echo is null on rows refused before the id parsed.
    id: row?.id ?? entry.id,
    name: row?.name ?? 'This story',
    code: entry.code,
    reason: entry.message,
  };
}

/**
 * Fold one 207 body into the per-row reconciliation the picker renders.
 *
 * `sent` is indexed by position, matching `operations`, so a row is named even when
 * the server could not echo its id back.
 */
export function reconcileStoryCommit(
  sent: CommittedStoryRef[],
  response: TaskBulkResponse,
): StoryCommitOutcome {
  const rejected = response.rejected.map((entry) => toProblem(sent, entry));
  const skipped = response.skipped.map((entry) => toProblem(sent, entry));
  const committedCount = response.applied.length;
  const retryIds = Array.from(
    new Set(rejected.map((p) => p.id).filter((id): id is string => id !== null)),
  );

  return {
    sentCount: sent.length,
    committedCount,
    rejected,
    skipped,
    retryIds,
    // Not `rejected.length === 0` alone: a batch that reported neither a rejection
    // nor a skip for a row it also did not apply is unaccounted for, and closing the
    // modal on it would claim a commit nothing in the response supports.
    isClean: rejected.length === 0 && skipped.length === 0 && committedCount === sent.length,
  };
}
