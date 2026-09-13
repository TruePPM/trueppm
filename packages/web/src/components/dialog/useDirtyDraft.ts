import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export interface DirtyDraft<T extends object> {
  /** The working copy the form binds its inputs to. */
  draft: T;
  /** Replace the whole draft (or update via an updater fn). */
  setDraft: Dispatch<SetStateAction<T>>;
  /** Update a single field on the draft. */
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  /** The last-committed snapshot the draft is compared against. */
  baseline: T;
  /** True while `draft` differs structurally from `baseline`. */
  dirty: boolean;
  /** Cancel — revert the draft back to the baseline, discarding pending edits. */
  reset: () => void;
  /**
   * Adopt the current draft (or an explicit value) as BOTH the baseline and the
   * draft — a re-seed. Not for an async save's success path: the draft it adopts
   * is whatever is in the field when the response lands, which includes anything
   * typed while the request was in flight. Use `markSaved` there.
   */
  commit: (next?: T) => void;
  /**
   * Re-baseline to `saved` — the snapshot that was actually submitted — leaving
   * the live draft untouched. Call from a save's `onSuccess` with the draft
   * captured when the request was sent, so the bar clears without a round-trip
   * through freshly-fetched props when nothing changed in flight, and stays up
   * when something did. `commit()` there would mark the unsent keystrokes as
   * saved, and a close would then discard them with no prompt (#3658).
   */
  markSaved: (saved: T) => void;
  /**
   * Re-baseline a SINGLE field (draft + baseline) to `value`, leaving every
   * other pending edit dirty. For an immediate side-write to one field while the
   * rest of the draft is still being edited (e.g. accepting a velocity
   * suggestion that PATCHes one column) — `commit()` would drop the other
   * pending edits, so it can't be used there.
   */
  commitField: <K extends keyof T>(key: K, value: T[K]) => void;
}

/**
 * Owns the draft / baseline / dirty triad shared by every editable
 * dialog/drawer that batches edits behind a Save/Cancel footer (web-rule 217).
 *
 * Extracted from the hand-rolled copies in `EpicDetailDrawer` and
 * `StoryDetailDrawer` (web-rule 164) so a new surface inherits the exact
 * dirty-compare + revert + post-save re-snapshot contract instead of
 * re-deriving it. The dirty compare is `JSON.stringify` — the same flat-scalar
 * precedent as `useDirtyForm` (settings) and the two backlog drawers; forms
 * with nested/ordered collections should keep those on their own immediate
 * endpoints (the carve-out in web-rule 164/217), not fold them into the draft.
 *
 * The baseline is captured once at mount (like the drawers' `useState(() =>
 * toDraft(x))`). To re-seed the form when the *identity* of the edited entity
 * changes while the surface stays mounted, remount it with a React `key` on the
 * entity id, or call `commit(nextInitial)` — this hook deliberately does not
 * auto-resync so a server-side update to the same record never clobbers an
 * in-progress edit.
 *
 * @param initial The initial form values; also the first baseline.
 *
 * @example
 * const { draft, setField, baseline, dirty, reset, markSaved } =
 *   useDirtyDraft<Draft>(toDraft(epic));
 * // …bind inputs to `draft`, call setField('name', v) on change…
 * patch.mutate(changedFields(draft, baseline), { onSuccess: () => markSaved(draft) });
 */
export function useDirtyDraft<T extends object>(initial: T): DirtyDraft<T> {
  const [baseline, setBaseline] = useState<T>(initial);
  const [draft, setDraft] = useState<T>(initial);

  // Keep the latest draft reachable from `commit()` without threading it
  // through the caller — mirrors the drawers' `setInitial(draft)` on success.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    // Computed-key spread over a generic T needs the cast — the object literal
    // widens to `T & { [key]: T[K] }`, which is structurally T.
    setDraft((d) => ({ ...d, [key]: value }) as T);
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  const reset = useCallback(() => setDraft(baseline), [baseline]);

  const commit = useCallback((next?: T) => {
    const value = next ?? draftRef.current;
    setBaseline(value);
    setDraft(value);
  }, []);

  const markSaved = useCallback((saved: T) => setBaseline(saved), []);

  const commitField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setBaseline((b) => ({ ...b, [key]: value }) as T);
    setDraft((d) => ({ ...d, [key]: value }) as T);
  }, []);

  return { draft, setDraft, setField, baseline, dirty, reset, commit, markSaved, commitField };
}
