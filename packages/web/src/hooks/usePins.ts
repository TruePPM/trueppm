/**
 * Per-user pins on projects and programs (#2390, ADR-0627).
 *
 * A pin is a private wayfinding shortcut, server-persisted so it follows the
 * user across devices. Nothing here reads or writes another user's pins — the
 * collection endpoint is self-scoped and takes no user parameter.
 */
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
import type { ToastAction } from '@/components/Toast/toastStore';
import { optimisticListUpdate } from '@/lib/optimisticCache';
import type { PinnedItem } from '@/api/types';

export const PINNED_KEY = ['me', 'pinned'] as const;

export type PinKind = 'project' | 'program';

/** The caller's own pinned projects + programs, most recently pinned first. */
export function usePinned() {
  return useQuery<PinnedItem[]>({
    queryKey: PINNED_KEY,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await apiClient.get<PinnedItem[]>('/auth/me/pinned/');
      // Guard the shape rather than trusting it: an E2E catch-all route returns
      // a `{count, results}` list envelope for every unmocked endpoint, and
      // letting that reach `.map` throws inside the rail and takes the whole app
      // down through the root error boundary.
      return Array.isArray(res.data) ? res.data : [];
    },
  });
}

function pinUrl(kind: PinKind, id: string): string {
  return kind === 'project' ? `/projects/${id}/pin/` : `/programs/${id}/pin/`;
}

interface TogglePinVars {
  kind: PinKind;
  id: string;
  /** Used verbatim in every toast. */
  name: string;
  /** The state being moved *to*. */
  next: boolean;
  /**
   * Set by the Undo path so undoing a pin does not itself raise an Undo toast —
   * two toasts, each offering to undo the other, is a loop with no exit.
   */
  silent?: boolean;
  /**
   * Supplied by list surfaces that hold their row order steady after a pin
   * (ADR-0627 §D14). When present, the confirmation toast offers "Re-sort now"
   * instead of "Undo", because on those surfaces the interesting next action is
   * *applying* the deferred move.
   */
  onResort?: () => void;
}

/** Design §5.3: 6s, stretched on a coarse pointer where the button is a thumb
 *  away rather than a cursor away. */
function toastDwellMs(): number {
  const coarse =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  return coarse ? 10_000 : 6_000;
}

/**
 * One pin toast at a time.
 *
 * Pins are fast and often repeated — pinning four projects in a row would
 * otherwise stack four Undo toasts whose buttons all look identical and each
 * undo a different thing. The newest replaces its predecessor, so the Undo on
 * screen always belongs to the pin the user just made.
 */
let lastPinToastId: string | null = null;

function pushPinToast(message: string, action: ToastAction): void {
  if (lastPinToastId) toast.dismiss(lastPinToastId);
  lastPinToastId = toast.action(message, action, { durationMs: toastDwellMs() });
}

/**
 * Toggle a pin, optimistically.
 *
 * The visual flip is immediate (the optimistic cache patch) but the *confirmation
 * toast waits for the server*. Firing it on click — as the pre-#2390 localStorage
 * version did — would produce "Pinned Apollo" followed 200ms later by "Couldn't
 * pin Apollo": two stacked, contradictory messages in the same live region.
 *
 * All three cache families are patched, not just the pins collection: each
 * toggle reads its own `pinned` prop from its surface's own payload (a project
 * or program row), so patching only the collection would leave the pin the user
 * just clicked unmoved.
 */
export function useTogglePin() {
  const qc = useQueryClient();

  // Undo and Retry both re-enter this same mutation from inside its own
  // callbacks, which cannot see the mutation object being defined. The ref is
  // read at click time — long after it has been filled in below — so the
  // indirection costs nothing and keeps one code path for all three entries.
  const reenterRef = useRef<(vars: TogglePinVars) => void>(() => {});
  const undo = (vars: TogglePinVars) => reenterRef.current(vars);

  const mutation = useMutation({
    mutationFn: async ({ kind, id, next }: TogglePinVars) => {
      const url = pinUrl(kind, id);
      if (next) await apiClient.post(url);
      else await apiClient.delete(url);
      return next;
    },

    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: PINNED_KEY });
      const { listKeys, detailKey } = cacheKeys(vars.kind, vars.id);

      // Snapshot by prefix so the rollback also restores the program *detail*
      // entry, which is a prefix-extension of the program list key. Taken before
      // any write, so a rollback restores the pre-mutation state exactly.
      const lists = listKeys.flatMap((key) => qc.getQueriesData({ queryKey: key }));
      const detail = qc.getQueryData(detailKey);

      // An absent pins cache means "not loaded", not "nothing pinned" — building
      // the next rail from a manufactured [] would drop every other pin off the
      // rail until the settle refetch (#2862).
      const pinned = optimisticListUpdate<PinnedItem>(qc, PINNED_KEY, (prev) => {
        const rest = prev.filter((p) => !(p.kind === vars.kind && p.id === vars.id));
        if (!vars.next) return rest;
        const optimistic: PinnedItem = {
          kind: vars.kind,
          id: vars.id,
          name: vars.name,
          code: null,
          program_id: null,
          program_name: null,
          pinned_at: new Date().toISOString(),
        };
        // Newest-pinned-first, matching the server's ordering.
        return [optimistic, ...rest];
      });

      patchIsPinned(qc, listKeys, detailKey, vars.id, vars.next);
      return { pinned, lists, detail };
    },

    onSuccess: (_data, vars) => {
      // An undo confirms itself by the glyph flipping back; a toast about a
      // toast is noise.
      if (vars.silent) return;

      // Pinned onto a surface that is holding its order steady: the useful next
      // action is applying the move, not reversing it (design §5.2/§5.3).
      if (vars.next && vars.onResort) {
        pushPinToast(`Pinned ${vars.name} — it'll move to the top next time`, {
          label: 'Re-sort now',
          onClick: vars.onResort,
        });
        return;
      }

      pushPinToast(vars.next ? `Pinned ${vars.name}` : `Unpinned ${vars.name}`, {
        label: 'Undo',
        ariaLabel: vars.next ? `Undo pinning ${vars.name}` : `Undo unpinning ${vars.name}`,
        onClick: () => {
          undo({ ...vars, next: !vars.next, silent: true, onResort: undefined });
        },
      });
    },

    onError: (err: unknown, vars, snapshot) => {
      if (snapshot) {
        const { detailKey } = cacheKeys(vars.kind, vars.id);
        qc.setQueryData(PINNED_KEY, snapshot.pinned);
        for (const [key, data] of snapshot.lists) qc.setQueryData(key, data);
        qc.setQueryData(detailKey, snapshot.detail);
      }
      // The cap is the one failure retrying cannot fix — offering Retry there
      // would invite the user to hammer a button that is guaranteed to fail.
      const message = pinErrorMessage(err, vars);
      if (extractErrorCode(err) === 'pin_limit_reached') {
        toast.error(message);
        return;
      }
      toast.action(
        message,
        { label: 'Retry', onClick: () => undo(vars) },
        { variant: 'error', durationMs: toastDwellMs() },
      );
    },

    onSettled: (_data, _err, vars) => {
      const { listKeys, detailKey } = cacheKeys(vars.kind, vars.id);
      void qc.invalidateQueries({ queryKey: PINNED_KEY });
      for (const key of listKeys) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: detailKey });
    },
  });

  reenterRef.current = (vars) => mutation.mutate(vars);
  return mutation;
}

/**
 * The cache keys a pin toggle has to touch, per kind.
 *
 * These are deliberately *not* symmetrical, because the two hooks that own them
 * were written years apart: the project detail key is the singular `['project',
 * id]`, while the program detail key is a prefix-extension of the program list
 * key, `['programs', id]`. Deriving them as `[kind, id]` — the obvious guess —
 * silently misses the program detail entry, so the star on a program's own
 * Overview header would not flip until a refetch.
 *
 * A **project** carries two list prefixes for the same reason. `useProgramProjects`
 * keys its rows under `['programs', {programId}, 'projects']` — the program that
 * owns them, not the entity being pinned — so the `['projects']` prefix does not
 * reach it and the Program → Projects tab was the one list surface where a pin
 * neither flipped optimistically nor refetched on settle (#2553). Sweeping
 * `['programs']` as well is safe because `patchRow` matches on the row's own id
 * and returns anything else untouched: a program row can never collide with a
 * project's UUID.
 */
function cacheKeys(kind: PinKind, id: string): { listKeys: string[][]; detailKey: string[] } {
  return kind === 'project'
    ? { listKeys: [['projects'], ['programs']], detailKey: ['project', id] }
    : { listKeys: [['programs']], detailKey: ['programs', id] };
}

/**
 * Flip the pinned flag on every cached copy of this entity.
 *
 * Three payload shapes reach this function and none of them agree:
 *
 * | cache key          | shape                       | flag        |
 * |--------------------|-----------------------------|-------------|
 * | `['projects']`     | `{items: Project[], count}` | `isPinned`  |
 * | `['project', id]`  | raw wire object             | `is_pinned` |
 * | `['programs'…]`    | `Program[]` *and* the detail object | `is_pinned` |
 *
 * `useProjects` maps the wire row into a camelCase domain object behind a
 * `{items, count}` envelope, so the naive "array of snake_case rows" patch is a
 * silent no-op for exactly the surface with the most pin toggles on it. The
 * program list key is a *prefix* of the program detail key, so a single
 * `setQueriesData` sweep reaches both — which is why the row patch must tolerate
 * a non-array payload rather than assuming a list.
 */
function patchIsPinned(
  qc: ReturnType<typeof useQueryClient>,
  listKeys: string[][],
  detailKey: string[],
  id: string,
  next: boolean,
): void {
  for (const listKey of listKeys) {
    qc.setQueriesData({ queryKey: listKey }, (prev: unknown) => patchAnyShape(prev, id, next));
  }
  qc.setQueryData(detailKey, (prev: unknown) => patchAnyShape(prev, id, next));
}

function patchAnyShape(prev: unknown, id: string, next: boolean): unknown {
  if (Array.isArray(prev)) return patchRows(prev, id, next);
  if (!isObject(prev)) return prev;
  // The `{items, count}` envelope used by useProjects.
  if (Array.isArray(prev.items)) {
    const items = patchRows(prev.items, id, next);
    return items === prev.items ? prev : { ...prev, items };
  }
  return patchRow(prev, id, next);
}

/**
 * Map, but return the *original* array when no row matched.
 *
 * A project pin sweeps the whole `['programs']` prefix (see `cacheKeys`), which
 * spans every program-scoped list in the cache — schedules, rollups, member
 * lists. An unconditional `.map` hands each of them a fresh array identity and
 * re-renders surfaces that hold no copy of the pinned entity at all. Preserving
 * the reference keeps the broad sweep cheap.
 */
function patchRows(rows: unknown[], id: string, next: boolean): unknown[] {
  let changed = false;
  const patched = rows.map((row) => {
    const result = patchRow(row, id, next);
    if (result !== row) changed = true;
    return result;
  });
  return changed ? patched : rows;
}

/** Patch whichever flag this row actually carries; leave a foreign row alone. */
function patchRow(row: unknown, id: string, next: boolean): unknown {
  if (!isObject(row) || row.id !== id) return row;
  if ('isPinned' in row) return { ...row, isPinned: next };
  return { ...row, is_pinned: next };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The cap gets its own message so the user learns *which* limit they hit.
 *
 * Keyed on the machine-readable `code`, never on the human sentence — the copy
 * and the locale can both change without the client noticing.
 */
function pinErrorMessage(err: unknown, vars: TogglePinVars): string {
  const code = extractErrorCode(err);
  if (code === 'pin_limit_reached') {
    return "You've pinned 100 items — unpin one to add another.";
  }
  return vars.next
    ? `Couldn't pin ${vars.name} — try again.`
    : `Couldn't unpin ${vars.name} — try again.`;
}

function extractErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const response = (err as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
