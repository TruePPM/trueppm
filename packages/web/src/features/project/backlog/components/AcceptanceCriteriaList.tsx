/**
 * Acceptance-criteria checklist for the story drawer (#731 / #1043). Each criterion
 * is a tickable row (text + `met` checkbox + remove); a persistent add input pins
 * to the bottom for rapid entry. Edits mutate immediately + optimistically (the team
 * ticks this checklist during review — Member+ writes, distinct from the Admin+/PO
 * scoring gate), with a server reconcile on settle so the DoR gate and AC meter stay
 * server-authoritative. The drawer's Ready control reads the same live met/total.
 */

import { useEffect, useState } from 'react';
import type { AcceptanceCriterion } from '@/types';
import { AcMeter } from './atoms';
import {
  useCreateCriterion,
  useDeleteCriterion,
  useUpdateCriterion,
} from '../hooks/useStoryDetail';
import { CloseIcon } from '@/components/Icons';

interface Props {
  projectId: string;
  taskId: string;
  criteria: AcceptanceCriterion[];
}

function signature(list: AcceptanceCriterion[]): string {
  return list.map((c) => `${c.id}:${c.met ? 1 : 0}:${c.position}:${c.text}`).join('|');
}

/**
 * Position-ordered copy — the canonical display order for the checklist.
 *
 * The three list transforms below are module-scope and pure so the optimistic
 * update and its rollback are the *same* expression applied to different values,
 * and so neither has to nest a `.map`/`.sort` callback inside a `setItems`
 * updater inside a mutation callback (five levels deep, Sonar S2004).
 */
function byPosition(list: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return [...list].sort((a, b) => a.position - b.position);
}

/** Apply `patch` to the criterion with `id`, leaving order and the rest untouched. */
function withPatch(
  list: AcceptanceCriterion[],
  id: string,
  patch: Partial<AcceptanceCriterion>,
): AcceptanceCriterion[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

/**
 * Flip `met` on the criterion with `id`, reading its value from `list` rather
 * than from a captured prop — under two rapid ticks the second updater must see
 * what the first already wrote, not the state at render time.
 */
function withToggledMet(list: AcceptanceCriterion[], id: string): AcceptanceCriterion[] {
  return list.map((x) => (x.id === id ? { ...x, met: !x.met } : x));
}

/** Re-insert a removed criterion in position order — the rollback for a failed delete. */
function withRestored(
  list: AcceptanceCriterion[],
  criterion: AcceptanceCriterion,
): AcceptanceCriterion[] {
  return byPosition([...list, criterion]);
}

export function AcceptanceCriteriaList({ projectId, taskId, criteria }: Props) {
  const create = useCreateCriterion(projectId);
  const update = useUpdateCriterion(projectId);
  const remove = useDeleteCriterion(projectId);

  // Local optimistic mirror of the server criteria, sorted by position. Re-seeds
  // whenever the server payload changes (the post-mutation invalidation is the
  // source of truth); edits commit to both local + server synchronously so a
  // reconcile never clobbers an in-flight change.
  const sorted = byPosition(criteria);
  const [items, setItems] = useState<AcceptanceCriterion[]>(sorted);
  const [draft, setDraft] = useState('');

  const serverSig = signature(sorted);
  useEffect(() => {
    setItems(byPosition(criteria));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSig, taskId]);

  const met = items.filter((c) => c.met).length;

  function toggleMet(c: AcceptanceCriterion) {
    setItems((prev) => withToggledMet(prev, c.id));
    update.mutate(
      { criterionId: c.id, patch: { met: !c.met } },
      { onError: () => setItems((prev) => withPatch(prev, c.id, { met: c.met })) },
    );
  }

  function commitText(c: AcceptanceCriterion, text: string) {
    const next = text.trim();
    if (!next || next === c.text) {
      // Empty or unchanged → snap back to the saved text, do not persist.
      setItems((prev) => withPatch(prev, c.id, { text: c.text }));
      return;
    }
    setItems((prev) => withPatch(prev, c.id, { text: next }));
    update.mutate({ criterionId: c.id, patch: { text: next } });
  }

  function removeCriterion(c: AcceptanceCriterion) {
    setItems((prev) => prev.filter((x) => x.id !== c.id));
    remove.mutate(
      { criterionId: c.id },
      { onError: () => setItems((prev) => withRestored(prev, c)) },
    );
  }

  function addCriterion() {
    const text = draft.trim();
    if (!text) return;
    setDraft(''); // clear immediately so the PO can keep typing the next criterion
    const position = items.length ? Math.max(...items.map((c) => c.position)) + 1 : 0;
    create.mutate({ taskId, text, position }, { onError: () => setDraft(text) });
  }

  return (
    <section aria-labelledby="drawer-ac-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3
          id="drawer-ac-heading"
          className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
        >
          Acceptance criteria
        </h3>
        <AcMeter met={met} total={items.length} />
      </div>

      {items.length === 0 && (
        <p className="rounded-control bg-neutral-surface-sunken px-3 py-2 text-xs text-neutral-text-secondary">
          No acceptance criteria yet. Add the conditions this story must meet to be Done.
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <label className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-control focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1">
              <input
                type="checkbox"
                checked={c.met}
                onChange={() => toggleMet(c)}
                aria-label={`Mark "${c.text}" met`}
                className="h-4 w-4 accent-semantic-on-track focus-visible:outline-none"
              />
            </label>
            <input
              type="text"
              defaultValue={c.text}
              onBlur={(e) => commitText(c, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  (e.target as HTMLInputElement).value = c.text;
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label={`Acceptance criterion: ${c.text}`}
              className={`flex-1 rounded-control border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-neutral-text-primary hover:border-neutral-border focus-visible:border-neutral-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
                c.met ? 'line-through decoration-neutral-text-disabled' : ''
              }`}
            />
            <button
              type="button"
              onClick={() => removeCriterion(c)}
              aria-label={`Remove "${c.text}"`}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-neutral-text-secondary hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2 rounded-control border-t border-neutral-border px-1.5 py-1 focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1">
        <span className="flex w-6 justify-center text-neutral-text-secondary" aria-hidden>
          +
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCriterion();
            } else if (e.key === 'Escape') {
              setDraft('');
            }
          }}
          placeholder="Add a criterion…"
          aria-label="Add an acceptance criterion"
          className="flex-1 bg-transparent text-[13px] text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
        />
        {draft.trim() && <span className="text-xs text-neutral-text-secondary">↵ to add</span>}
      </div>
    </section>
  );
}
