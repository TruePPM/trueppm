import { useEffect, useId, useRef } from 'react';
import { Button } from '@/components/Button';
import { InfoIcon, WarningIcon } from '@/components/Icons';
import type { Methodology, Project } from '@/types';

const METHODOLOGY_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

/**
 * What flipping TO each methodology hides, and from where the counts on
 * `Project` read (#3296). Orthogonal to the CURRENT methodology: the surfaces
 * a row already has data on are hidden the instant the value becomes the one
 * named here, regardless of what the row was set to before.
 */
const HIDDEN_ON: Partial<
  Record<
    Methodology,
    { surfaces: string; fields: { label: string; read: (p: Project) => number | undefined }[] }
  >
> = {
  WATERFALL: {
    surfaces: 'Sprints and Board',
    fields: [
      { label: 'sprint', read: (p) => p.sprintCount },
      { label: 'backlog story', read: (p) => p.backlogStoryCount },
    ],
  },
  AGILE: {
    surfaces: 'Schedule',
    fields: [
      { label: 'baseline', read: (p) => p.baselineCount },
      { label: 'dependency link', read: (p) => p.dependencyCount },
    ],
  },
};

function pluralize(n: number, noun: string): string {
  if (n === 1) return `1 ${noun}`;
  const plural = /[bcdfghjklmnpqrstvwxyz]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${n} ${plural}`;
}

/**
 * Bulk methodology apply's impact preview (#3296, D1-D9, D13-D15, D34-D35, D38).
 *
 * Swaps into the action-bar slot `ResetConfirm` already occupies when Apply is
 * pressed on the Methodology field, instead of writing immediately — the bulk
 * path's counterpart to the single-project flip warning
 * (`MethodologyFlipWarningDialog`). Unlike that dialog it is `role="group"`,
 * not `alertdialog`: this never blocks (naming the consequence is the point,
 * not adding a gate), so it must not read as one.
 *
 * All counts come from fields already on `Project` (`sprintCount`,
 * `backlogStoryCount`, `baselineCount`, `dependencyCount`) — annotated by the
 * same `GET /programs/{id}/projects/` read the page already made, so this
 * issues no request of its own. A row missing a count it needs (an older
 * cached response) makes the whole per-surface line "unknown" rather than
 * silently undercounting it — see `keepWarnable`'s sibling reasoning in
 * `ProjectMethodologyPage.tsx`: a failed/absent read is "cannot rule out", not
 * "zero".
 */
export function BulkMethodologyImpactPreview({
  selectedRows,
  value,
  entityNoun,
  onConfirm,
  onCancel,
  busy,
}: {
  selectedRows: Project[];
  value: Methodology;
  entityNoun: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const headingId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  // Moves focus into the new region on open (D38) — this is not a modal (no
  // `aria-modal`, no focus trap: Tab may still leave it), so a plain mount-time
  // focus is the whole contract. `ResetConfirm` beside it deliberately does NOT
  // get this — see its own D38 note in BulkFieldsMatrix.tsx.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const count = selectedRows.length;
  const label = METHODOLOGY_LABEL[value];
  const hidden = HIDDEN_ON[value];
  const alreadyMatching = selectedRows.filter((p) => p.methodology === value).length;

  let impactLine: string | null = null;
  if (hidden) {
    // Per-row, per-field counts. Any missing value makes the whole aggregate
    // unknown — never a silent undercount presented as the true total.
    const perRow = selectedRows.map((p) => hidden.fields.map((f) => f.read(p)));
    const known = perRow.every((counts) => counts.every((c) => c != null));
    if (known) {
      const totals = hidden.fields.map((f, i) => {
        const total = perRow.reduce((sum, counts) => sum + (counts[i] ?? 0), 0);
        return pluralize(total, f.label);
      });
      const affected = perRow.filter((counts) => counts.some((c) => (c ?? 0) > 0)).length;
      impactLine =
        affected > 0
          ? `${affected} of ${count} selected ${entityNoun} have ${hidden.surfaces.toLowerCase()} data that will be hidden, not deleted: ${totals.join(', ')}.`
          : `None of the ${count} selected ${entityNoun} have ${hidden.surfaces.toLowerCase()} data — nothing will be hidden.`;
    } else {
      impactLine = `Some selected ${entityNoun} may have ${hidden.surfaces.toLowerCase()} data that this hides — counts aren't available for this view.`;
    }
  }

  return (
    // Escape closes without writing, same as Cancel (D38). Bound here, not on a
    // single button, so it fires from anywhere focus lands inside the region.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role="group" region catching Escape while it holds focus; not a widget role, so the rule flags it
    <div
      ref={containerRef}
      role="group"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      className="flex w-full flex-col gap-2 focus-visible:outline-none"
      data-testid="bulk-methodology-preview"
    >
      <div className="flex flex-wrap items-start gap-2">
        {hidden ? (
          <WarningIcon
            className="mt-0.5 h-4 w-4 shrink-0 text-semantic-warning"
            aria-hidden="true"
          />
        ) : (
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-neutral-text-secondary" aria-hidden="true" />
        )}
        <div className="flex flex-col gap-1">
          <p id={headingId} className="text-[12px] font-medium text-neutral-text-primary">
            Set Methodology to <span className="font-semibold">{label}</span> on{' '}
            <span className="tppm-mono">{count}</span> selected {entityNoun}?
          </p>
          {impactLine && <p className="text-[11px] text-neutral-text-secondary">{impactLine}</p>}
          {alreadyMatching > 0 && (
            <p className="text-[11px] text-neutral-text-secondary">
              <span className="tppm-mono">{alreadyMatching}</span> of{' '}
              <span className="tppm-mono">{count}</span> already set to {label}.
            </p>
          )}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Applying…' : `Set ${label}`}
        </Button>
      </div>
    </div>
  );
}
