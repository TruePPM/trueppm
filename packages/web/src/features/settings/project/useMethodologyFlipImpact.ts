import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * DRF's paginated envelope. Only `count` is read — these are deliberately
 * count-only reads (`page_size=1`), never list fetches.
 */
interface CountEnvelope {
  count?: number;
}

/**
 * One count the pre-save methodology flip warning may name.
 *
 * `null` means the read failed, so the number is **unknown** — not zero. That
 * distinction is the whole point (#3313): a failed GET yields no rows either
 * way, and treating "no rows" as "nothing to lose" silently suppresses the one
 * warning that exists for the flip.
 */
export type FlipImpactCount = number | null;

export interface MethodologyFlipImpact {
  /**
   * Items in the project's product backlog — `status=BACKLOG AND sprint IS NULL`,
   * the scope the server itself calls "the product-backlog grooming list"
   * (`product_backlog_services._backlog_stories`). This is the population the
   * `product-backlog` view lists, and WATERFALL hides that view.
   */
  backlogCount: FlipImpactCount;
  /**
   * Live (non-deleted) tasks in the project — the population the Schedule
   * renders (every task; the undated ones sit in its Unscheduled gutter) and
   * the Calendar draws from. AGILE hides both views.
   */
  taskCount: FlipImpactCount;
  /**
   * Dependency links whose predecessor is in this project — the same set the
   * Gantt fetches for its arrows. The Schedule is the only surface that renders
   * them at all, so this is the count with nowhere else to go.
   */
  dependencyCount: FlipImpactCount;
  /**
   * True until every count has settled (resolved or failed).
   *
   * A readiness input for the SAVE, not for anything rendered: the flip trigger
   * is evaluated inside the save handler, and an unsettled count reads as 0
   * there, which skips the consent dialog on timing alone (#3313). The page
   * folds this into `apiReady` for exactly that reason.
   */
  isLoading: boolean;
}

/** `page_size=1` — the smallest page the server will build; we read `count` only. */
const COUNT_ONLY_PAGE_SIZE = 1;

interface CountQueryResult {
  count: FlipImpactCount;
  isLoading: boolean;
}

function useCountQuery(
  queryKey: readonly unknown[],
  path: string,
  params: Record<string, string | number>,
  enabled: boolean,
): CountQueryResult {
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await apiClient.get<CountEnvelope>(path, {
        params: { ...params, page_size: COUNT_ONLY_PAGE_SIZE },
      });
      return res.data.count ?? 0;
    },
    enabled,
  });
  return {
    // A failed read is "unknown", never 0 — see FlipImpactCount.
    count: query.error ? null : (query.data ?? 0),
    isLoading: query.isLoading,
  };
}

/**
 * Counts of everything a methodology flip would hide from this project's nav
 * (#3294).
 *
 * The flip warning that shipped with #2619 counted sprints only, so a WATERFALL
 * flip on a groomed-but-sprintless project passed silently and a flip to AGILE
 * — which hides Schedule *and* Calendar — had no warning at all. The trigger
 * needs a count per hidden view, and `methodologyTabs.ts` already names all
 * four of them.
 *
 * Three count-only reads (`page_size=1`; the response body is one row and the
 * envelope's `count` is the whole point) rather than one new endpoint:
 *
 *  - `GET /tasks/?project=…&status=BACKLOG&sprint=none` — the product backlog.
 *  - `GET /tasks/?project=…` — every live task, for the Schedule/Calendar side.
 *  - `GET /dependencies/?project=…` — the Gantt's edge set.
 *
 * Deliberately NOT `GET /projects/{id}/product-backlog/`, which would return
 * the exact `health.story_count` but serialize every story with its criteria,
 * labels, assignments and custom fields to do it — a grooming payload fetched
 * on a settings page to read one integer. The `status=BACKLOG AND sprint IS
 * NULL` filter above is that same list's documented scope; it differs only in
 * counting an epic whose own status is BACKLOG, which is a row that view does
 * render. Every item counted here is genuinely on the surface being hidden.
 *
 * **Gated on a flip actually being pending**, unlike the sprints read beside it.
 * The consolidated settings page mounts every section at once, so an
 * unconditional read here would fire three counts on *every* project settings
 * route — including `/settings/team`, which has nothing to do with methodology —
 * and `GET /tasks/?project=…` is not free on a large project. Starting them when
 * the user picks a different card does NOT reintroduce the #3313 hole, because
 * `isLoading` is a readiness input: the page withholds the save until these
 * settle, so the trigger is never evaluated against a count nobody knows yet.
 * With no flip pending the queries stay idle and `isLoading` is false, so the
 * section's other controls (estimate governance, estimation scale) are not held
 * behind a read they do not need.
 *
 * @param projectId The project whose flip impact to read.
 * @param enabled Whether a methodology change is pending. Queries stay idle when
 *   false, and every count reads 0 — safe, because with no flip pending there is
 *   no trigger to evaluate.
 * @returns Each count, `null` where the read failed, plus a combined loading flag.
 */
export function useMethodologyFlipImpact(
  projectId: string | null | undefined,
  enabled: boolean,
): MethodologyFlipImpact {
  const on = enabled && !!projectId;
  const backlog = useCountQuery(
    ['methodology-flip-impact', 'backlog', projectId],
    '/tasks/',
    { project: projectId ?? '', status: 'BACKLOG', sprint: 'none' },
    on,
  );
  const tasks = useCountQuery(
    ['methodology-flip-impact', 'tasks', projectId],
    '/tasks/',
    { project: projectId ?? '' },
    on,
  );
  const dependencies = useCountQuery(
    ['methodology-flip-impact', 'dependencies', projectId],
    '/dependencies/',
    { project: projectId ?? '' },
    on,
  );

  return {
    backlogCount: backlog.count,
    taskCount: tasks.count,
    dependencyCount: dependencies.count,
    isLoading: backlog.isLoading || tasks.isLoading || dependencies.isLoading,
  };
}
