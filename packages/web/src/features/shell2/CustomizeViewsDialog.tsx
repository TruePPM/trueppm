import { useId } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectViewSet, ResolvedView } from '@/api/types';
import { Toggle } from '@/features/settings/components/Toggle';
import {
  useResetProjectViews,
  useUpdateProjectViews,
  viewsErrorDetail,
} from '@/hooks/useProjectViews';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { lensLabel } from './ViewsRow3';

/** Plan layouts: the server refuses hiding the last visible one (`last_plan_layout`). */
const PLAN_LAYOUTS = new Set(['schedule', 'grid', 'calendar']);

const BTN =
  'inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-p1-brand hover:bg-p1-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus disabled:opacity-50';

interface Props {
  projectId: string;
  projectName: string;
  viewSet: ProjectViewSet;
  labelFor: (view: string) => string;
  onClose: () => void;
}

interface Row {
  view: ResolvedView;
  label: string;
  /** The source label, with its glyph (Pass 5 1B §3). */
  status: string;
  /** Why the switch cannot be flipped; the switch stays focusable and says so. */
  locked: string | null;
  askAdmin: boolean;
}

/**
 * Turns the server's resolved set into one row per view. The label is decided by
 * `source` alone, never re-derived: the server owns precedence (ADR-1478 §3).
 */
export function buildRows(
  viewSet: ProjectViewSet,
  labelFor: (view: string) => string,
  workspaceName: string | undefined,
  formatDate: (iso: string) => string,
): Row[] {
  const visiblePlan = viewSet.views.filter((v) => PLAN_LAYOUTS.has(v.key) && v.visible);
  return viewSet.views.map((view) => {
    const name = labelFor(view.key);
    const label = PLAN_LAYOUTS.has(view.key) ? `Plan › ${name}` : name;
    const lastPlan = visiblePlan.length === 1 && visiblePlan[0]?.key === view.key;
    let status = 'Shown';
    let locked: string | null = null;
    let askAdmin = false;
    if (view.source === 'always' || lastPlan) {
      status = '■ Always on';
      locked = lastPlan ? "The last Plan layout can't be hidden." : 'This view is always on.';
    } else if (view.binding === 'enforced') {
      status = `⊘ Off in ${workspaceName || 'this workspace'}`;
      locked = 'A workspace admin turned this area off.';
      askAdmin = true;
    } else if (!view.visible && view.source === 'seed') {
      status = `◌ Suggested hidden · ${lensLabel(view.lens ?? '')}`;
    } else if (!view.visible && view.source === 'user') {
      status = view.at ? `⊖ Hidden by you · ${formatDate(view.at)}` : '⊖ Hidden by you';
    } else if (!view.visible && view.source === 'methodology') {
      status = 'Not in this methodology';
    }
    return { view, label, status, locked, askAdmin };
  });
}

/**
 * "Views in {project}" (Redesign Pass 5 · 1B §3): one switch per view with the reason it
 * is shown or hidden, opened from More › Customize views…. Every write is the caller's
 * own per-project row; nothing here changes what anyone else sees or may do.
 */
export function CustomizeViewsDialog({
  projectId,
  projectName,
  viewSet,
  labelFor,
  onClose,
}: Props) {
  const titleId = useId();
  const errorId = useId();
  // Always active while mounted: seats focus, wraps Tab, Escape closes, restores the opener.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const update = useUpdateProjectViews(projectId);
  const reset = useResetProjectViews(projectId);
  // Read only when the dialog opens, so the header costs no extra request.
  const workspaceName = useWorkspaceSettings().data?.name;
  const { formatInstantDate } = useUserDateFormat();
  const rows = buildRows(viewSet, labelFor, workspaceName, (iso) =>
    formatInstantDate(iso, 'short'),
  );
  const busy = update.isPending || reset.isPending;
  const error = viewsErrorDetail(update.error ?? reset.error);
  const failed = (update.isError || reset.isError) && !error;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 md:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg border border-p1-hairline-strong bg-p1-surface-1 p-4 text-p1-text-1 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-base font-semibold">
            Views in {projectName}
          </h2>
          <button type="button" className={BTN} aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <p className="mt-1 text-sm text-p1-text-2">
          Only for you, in this project. Hiding a view removes it from your tabs, but it stays
          reachable from More and by link. It never changes what anyone can see or do.
        </p>
        <ul className="mt-3 divide-y divide-p1-hairline">
          {rows.map((r) => {
            const captionId = `${titleId}-${r.view.key}`;
            return (
              <li key={r.view.key} className="flex min-h-12 items-center gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{r.label}</div>
                  <div id={captionId} className="text-xs text-p1-text-3">
                    {r.status}
                    {r.locked && ` · ${r.locked}`}
                  </div>
                </div>
                {r.askAdmin && <span className="text-xs text-p1-text-2">Ask an admin</span>}
                <Toggle
                  on={r.view.visible}
                  onChange={(on) => {
                    if (r.locked || busy) return;
                    update.mutate({ key: r.view.key, hidden: !on });
                  }}
                  onLabel="On"
                  offLabel="Off"
                  ariaLabel={`${r.label}: ${r.view.visible ? 'shown' : 'hidden'}`}
                  describedBy={captionId}
                  softDisabled={r.locked !== null}
                  busy={busy}
                />
              </li>
            );
          })}
        </ul>
        {(error || failed) && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-p1-critical">
            {error ?? "Your views couldn't be saved. Try again."}
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={() => reset.mutate()}>
            Reset to {lensLabel(viewSet.lens)} suggestions
          </button>
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => update.mutate({ clear_seed: true })}
          >
            Show all
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
