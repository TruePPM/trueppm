import { useEffect, useRef, useState } from 'react';
import type { ProjectViewSet, SeedDiff } from '@/api/types';
import { useApplyLensSeed, useUpdateProjectViews } from '@/hooks/useProjectViews';

/** Display names for `RoleContext` values. The PO lens arrives with #1467. */
export const LENS_LABEL: Record<string, string> = {
  pm: 'Project Manager',
  scrum_master: 'Scrum Master',
  unified: 'Unified Today',
};
export const lensLabel = (lens: string) => LENS_LABEL[lens] ?? lens;

const ROW =
  'mt-1 flex min-h-[40px] flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs text-p1-text-2';
const BTN =
  'inline-flex h-8 min-w-8 items-center justify-center rounded px-2 text-xs font-medium text-p1-brand hover:bg-p1-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus disabled:opacity-50';

interface Props {
  projectId: string;
  viewSet: ProjectViewSet;
  labelFor: (view: string) => string;
  /** The open view, when it is hidden from the tabs but was opened from More or by link. */
  openHiddenView?: string | null;
}

/**
 * Row 3 of the project header (Redesign Pass 5 §1): the one-time seed explainer (1A), the
 * "Keep {view} in your tabs" offer when a hidden view is open (1B), or, after a lens
 * change, the "Apply {lens} suggestions…" offer and its diff confirm (1C).
 *
 * Renders only what the server says: `seed_line` and `lens_offer` come from
 * `GET /projects/{id}/views/`, so dismissal survives reloads and devices. The offer
 * outranks the seed line because it is the one case where a banner replaces row 3.
 */
export function ViewsRow3({ projectId, viewSet, labelFor, openHiddenView }: Props) {
  const update = useUpdateProjectViews(projectId);
  const apply = useApplyLensSeed(projectId);
  const [diff, setDiff] = useState<SeedDiff | null>(null);
  const offer = viewSet.lens_offer;

  if (offer) {
    return (
      <div role="region" aria-label="View suggestions" className={ROW}>
        {diff ? (
          <DiffConfirm
            diff={diff}
            labelFor={labelFor}
            pending={apply.isPending}
            onApply={() =>
              apply.mutate({ lens: offer, dry_run: false }, { onSuccess: () => setDiff(null) })
            }
            onCancel={() => setDiff(null)}
          />
        ) : (
          <>
            <span>Your view focus is {lensLabel(offer)}.</span>
            <button
              type="button"
              className={BTN}
              disabled={apply.isPending}
              onClick={() => apply.mutate({ lens: offer, dry_run: true }, { onSuccess: setDiff })}
            >
              Apply {lensLabel(offer)} suggestions…
            </button>
            <button
              type="button"
              className={BTN}
              aria-label={`Dismiss ${lensLabel(offer)} suggestions`}
              onClick={() => update.mutate({ lens_offer_dismissed: offer })}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </>
        )}
      </div>
    );
  }

  // 1B §1: opening a hidden view does not un-hide it; row 3 offers to keep it instead.
  if (openHiddenView) {
    const label = labelFor(openHiddenView);
    return (
      <div className={ROW} data-testid="views-keep-in-tabs">
        <span>{label} is hidden from your tabs.</span>
        <button
          type="button"
          className={BTN}
          disabled={update.isPending}
          onClick={() => update.mutate({ key: openHiddenView, hidden: false })}
        >
          Keep {label} in your tabs
        </button>
      </div>
    );
  }

  const line = viewSet.seed_line;
  if (!line) return null;
  const n = line.hidden_count;
  return (
    <div className={ROW} data-testid="views-seed-line">
      <span aria-hidden="true">◌</span>
      <span>
        Shown for {lensLabel(line.lens)}s · {n} {n === 1 ? 'view' : 'views'} hidden
      </span>
      <button type="button" className={BTN} onClick={() => update.mutate({ clear_seed: true })}>
        Show all
      </button>
      <button
        type="button"
        className={BTN}
        aria-label="Dismiss this note"
        onClick={() => update.mutate({ seed_line_dismissed: true })}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

function names(keys: string[], labelFor: (v: string) => string): string {
  return keys.length ? keys.map(labelFor).join(', ') : 'Nothing';
}

/**
 * The 1C confirm: Will hide · Will open on · Kept. "Kept" names the person's own choices
 * so they visibly survive; the action states its count and is never "OK".
 */
function DiffConfirm({
  diff,
  labelFor,
  pending,
  onApply,
  onCancel,
}: {
  diff: SeedDiff;
  labelFor: (v: string) => string;
  pending: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const n = diff.change_count;
  // The "Apply suggestions…" button that opened this confirm is gone, so seat focus on
  // the confirm's action instead of letting it fall to <body>.
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => firstAction.current?.focus(), []);
  const kept = diff.kept.map((k) => `${labelFor(k.view)} (${k.hidden ? 'hidden' : 'shown'})`);
  return (
    <div className="flex w-full flex-col gap-1 rounded-md border border-p1-hairline-strong bg-p1-surface-1 p-2">
      <p className="font-medium text-p1-text-1">Apply {lensLabel(diff.lens)} suggestions</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt>Will hide</dt>
        <dd>{names(diff.will_hide, labelFor)}</dd>
        {diff.will_show.length > 0 && (
          <>
            <dt>Will show again</dt>
            <dd>{names(diff.will_show, labelFor)}</dd>
          </>
        )}
        <dt>Will open on</dt>
        <dd>{diff.will_open_on ? labelFor(diff.will_open_on) : 'No change'}</dd>
        <dt>Kept</dt>
        <dd>
          {kept.length
            ? `Your choices: ${kept.join(', ')}`
            : 'You have no choices of your own here'}
        </dd>
      </dl>
      <div className="flex gap-1">
        <button
          ref={firstAction}
          type="button"
          className={BTN}
          disabled={pending || n === 0}
          onClick={onApply}
        >
          Apply {n} {n === 1 ? 'change' : 'changes'}
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
