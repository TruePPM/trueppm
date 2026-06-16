/**
 * ViewVisibilitySection — the /me/settings/general variant of the "Customize
 * views" control (ADR-0139). Same per-user global hidden-views preference as the
 * shell `ViewsMenu`, rendered as a plain settings form (grouped `role="switch"`
 * rows) rather than a dropdown.
 *
 * No project/methodology context here (this page is global), so every hideable
 * view is listed and "Reset to default" clears the whole personal set. Overview
 * is shown as a static always-on row. Optimistic local state, reverted on error,
 * mirroring the page's landing-preference pattern.
 */
import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUpdateHiddenViews } from '@/hooks/useUpdateHiddenViews';
import { VIEW_GROUPS, STANDALONE_LEADING } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { Toggle } from '@/features/settings/components/Toggle';

export function ViewVisibilitySection() {
  const { user } = useCurrentUser();
  const update = useUpdateHiddenViews();

  const [pending, setPending] = useState<string[] | null>(null);
  const serverHidden = useMemo(() => user?.hidden_views ?? [], [user?.hidden_views]);
  const effectiveHidden = pending ?? serverHidden;
  const hiddenSet = new Set(effectiveHidden);

  useEffect(() => {
    if (pending !== null && JSON.stringify(pending) === JSON.stringify(serverHidden)) {
      setPending(null);
    }
  }, [pending, serverHidden]);

  function commit(next: string[]) {
    setPending(next);
    update.mutate(next, { onError: () => setPending(null) });
  }

  function toggle(view: string) {
    const next = hiddenSet.has(view)
      ? effectiveHidden.filter((v) => v !== view)
      : [...effectiveHidden, view];
    commit(next);
  }

  const canReset = effectiveHidden.length > 0;

  return (
    <section
      aria-labelledby="view-visibility-heading"
      className="flex flex-col gap-3 rounded border border-neutral-border p-4"
    >
      <div>
        <h2
          id="view-visibility-heading"
          className="text-sm font-semibold text-neutral-text-primary"
        >
          Views
        </h2>
        <p className="mt-0.5 text-sm text-neutral-text-secondary">
          Hide the view tabs you don&rsquo;t use. Hidden views stay reachable from the Views menu
          and the command palette. Applies to every project (each project also hides views that
          don&rsquo;t fit its methodology).
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
          Always on
        </p>
        <p className="text-sm text-neutral-text-secondary">
          {VIEW_TAB_META[STANDALONE_LEADING].label} — always shown
        </p>
      </div>

      {VIEW_GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            {group.id}
          </p>
          {group.views.map((view) => {
            const visible = !hiddenSet.has(view);
            const label = VIEW_TAB_META[view]?.label ?? view;
            return (
              <Toggle
                key={view}
                on={visible}
                onChange={() => toggle(view)}
                onLabel={label}
                offLabel={label}
                ariaLabel={`${label} — ${visible ? 'shown' : 'hidden'}`}
              />
            );
          })}
        </div>
      ))}

      <div>
        <button
          type="button"
          onClick={() => commit([])}
          disabled={!canReset}
          title={canReset ? undefined : 'No views hidden'}
          className="text-sm text-brand-primary hover:underline disabled:text-neutral-text-secondary disabled:no-underline disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
        >
          Reset to default
        </button>
      </div>
    </section>
  );
}
