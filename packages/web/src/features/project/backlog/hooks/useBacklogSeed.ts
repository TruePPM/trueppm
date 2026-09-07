import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTemplateApplication } from '@/hooks/useProjectTemplates';
import { setSearchParam } from '@/hooks/useUrlSelectedId';
import { productBacklogKeys } from './useProductBacklog';

/**
 * How long the seeding skeleton may stand with no terminal status before it yields
 * to the ordinary empty state (web rule 374(a)). Matches `ScheduleView`'s timer,
 * and for the same reason: this polls the application's REAL status, so the timer
 * is the last resort for a worker that died without writing one — not the primary
 * exit it was when the page guessed from a URL flag (ADR-0800 §4's 10s).
 */
export const BACKLOG_SEED_TIMEOUT_MS = 60_000;

/** The inputs `resolveBacklogSeeding` reads, as returned by `useBacklogSeed`. */
export interface BacklogSeedState {
  /** The application being polled, or `null` when nothing was applied on arrival. */
  applicationId: string | null;
  status: string | undefined;
  applicationLoading: boolean;
  timedOut: boolean;
  /** The user closed the failure banner; nothing can reopen it (rule 381(f)). */
  failureDismissed: boolean;
  dismissFailure: () => void;
  /** A retry minted a NEW application — swap to it and release every latch. */
  handleRetried: (nextApplicationId: string) => void;
}

/**
 * Is a just-dispatched template apply still writing this backlog's rows? (#3422)
 *
 * The backlog twin of `resolveScheduleSeeding`, and deliberately the same shape,
 * because the two disagreeing is how the agile landing went silent: the Schedule
 * polled the application while this page read a `?seeding=1` flag, so the backlog
 * could not tell "still writing" from "failed" and rendered the same skeleton for
 * both until a timer ran out.
 *
 * - `applicationLoading` covers the window BEFORE the first poll resolves, so the
 *   empty-backlog CTA never paints for one render between mount and first byte.
 * - `timedOut` is the bounded exit (rule 374(a)) for a worker that died without
 *   writing a terminal status — the query keeps SUCCEEDING with `pending`, so
 *   nothing else would ever end the skeleton.
 * - `storyCount` gates on ALL stories, never a filtered subset.
 * - A terminal `failed` is NOT seeding (rule 381(a)). The apply rolled back in one
 *   transaction, so the backlog really is empty and its ordinary empty state is
 *   correct; `SeedFailureBanner` states the failure ABOVE it rather than this
 *   predicate growing a third arm.
 */
export function resolveBacklogSeeding(
  seed: Pick<BacklogSeedState, 'applicationId' | 'status' | 'applicationLoading' | 'timedOut'>,
  storyCount: number,
): boolean {
  if (seed.applicationId === null || seed.timedOut || storyCount > 0) return false;
  return seed.applicationLoading || seed.status === 'pending' || seed.status === 'running';
}

/**
 * Owns the `?templateApplication=` landing for the product backlog (#3422,
 * amending ADR-0800 §4).
 *
 * `createdProjectDestination` routes an AGILE project whose template apply just
 * fired to `/product-backlog?templateApplication=<id>`. Until #3422 it carried
 * `?seeding=1` instead — a boolean fixed at navigation time, which by construction
 * cannot carry a status the server writes LATER. A failed apply therefore showed
 * "Setting up your backlog…" for 10s and then fell through to the ordinary empty
 * CTA, saying nothing — the exact silence #3348 removed from the Schedule.
 *
 * Mirrors `ScheduleView`'s seed block, latch for latch:
 *
 * - The id is consumed ONE-SHOT into state and stripped from the URL, so a reload
 *   does not reopen a banner for an apply the user already dismissed (rule 374(b)).
 * - On terminal `success` the backlog query is invalidated once. The rows ride
 *   `task_*` WS events into `['product-backlog', projectId]` (`useProjectWebSocket`),
 *   but a degraded socket would clear the skeleton on the 2s poll and hand the user
 *   an empty CTA with the rows still in flight — rule 374's corollary.
 * - A retry from `SeedFailureBanner` mints a NEW application, so `handleRetried`
 *   resets the success latch, the timer, and the dismissal along with the id
 *   (rule 381(d)). Any one left set makes the retry look like it worked and then
 *   quietly land on an empty backlog.
 * - The failure banner's dismissal is its OWN flag, never `setApplicationId(null)`:
 *   the banner is the only reader of `error_detail` on this surface and the id was
 *   stripped on consume, so nulling the handle would be unrecoverable (rule 381(f)).
 */
export function useBacklogSeed(projectId: string | undefined): BacklogSeedState {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const paramConsumedRef = useRef(false);
  useEffect(() => {
    if (paramConsumedRef.current) return;
    const fromUrl = searchParams.get('templateApplication');
    if (!fromUrl) return;
    paramConsumedRef.current = true;
    setApplicationId(fromUrl);
    setSearchParam(setSearchParams, 'templateApplication', null);
  }, [searchParams, setSearchParams]);

  // Same query key as `SeedFailureBanner`, so the pair shares one cache entry and
  // adds no request; `refetchInterval` already stops on a terminal status.
  const { data: application, isPending: applicationLoading } =
    useTemplateApplication(applicationId);
  const status = application?.status;

  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!applicationId) return;
    const timer = setTimeout(() => setTimedOut(true), BACKLOG_SEED_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [applicationId]);

  const terminalHandledRef = useRef(false);
  useEffect(() => {
    if (terminalHandledRef.current || !projectId) return;
    if (status !== 'success') return;
    terminalHandledRef.current = true;
    void queryClient.invalidateQueries({ queryKey: productBacklogKeys.root(projectId) });
  }, [status, projectId, queryClient]);

  const [failureDismissed, setFailureDismissed] = useState(false);
  const dismissFailure = useCallback(() => setFailureDismissed(true), []);

  const handleRetried = useCallback((nextApplicationId: string) => {
    terminalHandledRef.current = false;
    setTimedOut(false);
    setFailureDismissed(false);
    setApplicationId(nextApplicationId);
  }, []);

  return {
    applicationId,
    status,
    applicationLoading,
    timedOut,
    failureDismissed,
    dismissFailure,
    handleRetried,
  };
}
