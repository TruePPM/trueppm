import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiClient } from '@/api/client';
import type { KeySuggestionResponse } from '@/api/types';
import type { RefKind } from '@/lib/refPath';

/**
 * The key form's debounce (ADR-1237 UX §1): one request per pause in typing, not
 * per keystroke. `/keys/` shares the per-user `resolve` throttle (120/min), so an
 * undebounced field would spend that budget in a sentence.
 */
export const KEY_CHECK_DEBOUNCE_MS = 300;

/** `value`, once it has held still for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number = KEY_CHECK_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * `GET /api/v1/keys/?kind=&name=` — the key the server would derive for `name`
 * (`Platform Migration` → `PM`, or `PM2` when `PM` is taken), debounced 300 ms.
 *
 * Disabled for a blank name: nothing is suggested for an empty Name (UX §1). The
 * previous suggestion is kept while the next one loads, so the field does not
 * flicker empty between keystrokes.
 *
 * @param kind - `'project'` or `'program'` — the two key namespaces are separate.
 * @param name - The Name field's current value.
 */
export function useKeySuggestion(
  kind: RefKind,
  name: string,
): UseQueryResult<KeySuggestionResponse> {
  const debouncedName = useDebounced(name.trim());
  return useQuery({
    queryKey: ['keys', 'suggest', kind, debouncedName],
    queryFn: async () => {
      const res = await apiClient.get<KeySuggestionResponse>('/keys/', {
        params: { kind, name: debouncedName },
      });
      return res.data;
    },
    enabled: debouncedName.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
  });
}

export interface KeyAvailabilityOptions {
  /** False suppresses the check (a format error, an untouched field, an unchanged key). */
  enabled: boolean;
  /**
   * The object being renamed. Its own current and retired keys then read as
   * available — renaming back is allowed (ADR-1237 §3). Omit on create.
   */
  objectId?: string;
}

export interface KeyAvailability {
  /** The server's answer for `debouncedKey`, when there is one. */
  data: KeySuggestionResponse | undefined;
  /** The value the answer is about — lags the field by the debounce. */
  debouncedKey: string;
  /** True while the field has moved on from the answer (debouncing or fetching). */
  pending: boolean;
  /** True while a request is actually on the wire. */
  fetching: boolean;
}

/**
 * `GET /api/v1/keys/?kind=&key=[&object_id=]` — whether `key` can be used,
 * debounced 300 ms (ADR-1237 §6).
 *
 * The answer is an existence oracle by design: "taken" never says by whom. It is
 * advisory only — `POST`/`PATCH` re-validate, and a race lost between the check and
 * the save comes back as a `400` on `code`.
 *
 * @param kind - `'project'` or `'program'`.
 * @param key - The key field's current (already case-normalized) value.
 * @param options - {@link KeyAvailabilityOptions}.
 */
export function useKeyAvailability(
  kind: RefKind,
  key: string,
  { enabled, objectId }: KeyAvailabilityOptions,
): KeyAvailability {
  const debouncedKey = useDebounced(key);
  const active = enabled && debouncedKey.length > 0 && debouncedKey === key;
  const query = useQuery({
    queryKey: ['keys', 'check', kind, debouncedKey, objectId ?? null],
    queryFn: async () => {
      const res = await apiClient.get<KeySuggestionResponse>('/keys/', {
        params: { kind, key: debouncedKey, ...(objectId ? { object_id: objectId } : {}) },
      });
      return res.data;
    },
    enabled: active,
    staleTime: 10 * 1000,
    retry: false,
  });
  return {
    data: active ? query.data : undefined,
    debouncedKey,
    pending: enabled && (debouncedKey !== key || query.isFetching),
    fetching: active && query.isFetching,
  };
}
