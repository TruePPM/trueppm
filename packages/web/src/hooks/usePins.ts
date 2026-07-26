/**
 * Per-user pins on projects and programs (#2390, ADR-0627).
 *
 * A pin is a private wayfinding shortcut, server-persisted so it follows the
 * user across devices. Nothing here reads or writes another user's pins — the
 * collection endpoint is self-scoped and takes no user parameter.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
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
  /** Used verbatim in both toasts. */
  name: string;
  /** The state being moved *to*. */
  next: boolean;
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
 * or program row), so patching only the collection would leave the star the user
 * just clicked unmoved.
 */
export function useTogglePin() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ kind, id, next }: TogglePinVars) => {
      const url = pinUrl(kind, id);
      if (next) await apiClient.post(url);
      else await apiClient.delete(url);
      return next;
    },

    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: PINNED_KEY });
      const { listKey, detailKey } = cacheKeys(vars.kind, vars.id);

      const snapshot = {
        pinned: qc.getQueryData<PinnedItem[]>(PINNED_KEY),
        // Snapshot by prefix so the rollback also restores the program *detail*
        // entry, which is a prefix-extension of the program list key.
        lists: qc.getQueriesData({ queryKey: listKey }),
        detail: qc.getQueryData(detailKey),
      };

      qc.setQueryData<PinnedItem[]>(PINNED_KEY, (prev) => {
        const rest = (prev ?? []).filter((p) => !(p.kind === vars.kind && p.id === vars.id));
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

      patchIsPinned(qc, listKey, detailKey, vars.id, vars.next);
      return snapshot;
    },

    onSuccess: (_data, vars) => {
      toast.info(vars.next ? `Pinned ${vars.name}` : `Unpinned ${vars.name}`);
    },

    onError: (err: unknown, vars, snapshot) => {
      if (snapshot) {
        const { detailKey } = cacheKeys(vars.kind, vars.id);
        qc.setQueryData(PINNED_KEY, snapshot.pinned);
        for (const [key, data] of snapshot.lists) qc.setQueryData(key, data);
        qc.setQueryData(detailKey, snapshot.detail);
      }
      toast.error(pinErrorMessage(err, vars));
    },

    onSettled: (_data, _err, vars) => {
      const { listKey, detailKey } = cacheKeys(vars.kind, vars.id);
      void qc.invalidateQueries({ queryKey: PINNED_KEY });
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: detailKey });
    },
  });
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
 */
function cacheKeys(kind: PinKind, id: string): { listKey: string[]; detailKey: string[] } {
  return kind === 'project'
    ? { listKey: ['projects'], detailKey: ['project', id] }
    : { listKey: ['programs'], detailKey: ['programs', id] };
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
  listKey: string[],
  detailKey: string[],
  id: string,
  next: boolean,
): void {
  qc.setQueriesData({ queryKey: listKey }, (prev: unknown) => patchAnyShape(prev, id, next));
  qc.setQueryData(detailKey, (prev: unknown) => patchAnyShape(prev, id, next));
}

function patchAnyShape(prev: unknown, id: string, next: boolean): unknown {
  if (Array.isArray(prev)) return prev.map((row) => patchRow(row, id, next));
  if (!isObject(prev)) return prev;
  // The `{items, count}` envelope used by useProjects.
  if (Array.isArray(prev.items)) {
    return { ...prev, items: prev.items.map((row) => patchRow(row, id, next)) };
  }
  return patchRow(prev, id, next);
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
