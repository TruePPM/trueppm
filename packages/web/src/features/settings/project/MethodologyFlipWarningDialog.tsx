import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { hiddenViewsForMethodology } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import type { IterationLabelForms } from '@/lib/iterationLabel';
import type { Methodology } from '@/types';

/**
 * The two methodologies that hide anything (`methodologyTabs.ts`). HYBRID hides
 * nothing, so there is no flip to it worth confirming.
 */
export type MethodologyFlipTarget = Extract<Methodology, 'WATERFALL' | 'AGILE'>;

/** What kind of thing a flip would hide. One kind per count the dialog names. */
export type FlipImpactKind = 'sprints' | 'backlog' | 'tasks' | 'dependencies';

export interface FlipImpact {
  kind: FlipImpactKind;
  /**
   * How many exist. `null` when the read failed and the total is therefore
   * unknown (#3313) — the dialog still warns, the safe direction on a flip that
   * hides the surface, but says the number could not be checked instead of
   * printing one it cannot stand behind.
   */
  count: number | null;
}

interface MethodologyFlipWarningDialogProps {
  /** The methodology being switched TO — decides the title, copy and views named. */
  target: MethodologyFlipTarget;
  /**
   * Everything the flip hides that this project actually has, in the order it
   * should be named. The caller filters out zero counts; an empty list means no
   * dialog should have opened at all.
   */
  impacts: FlipImpact[];
  itl: IterationLabelForms;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const TARGET_LABEL: Record<MethodologyFlipTarget, string> = {
  WATERFALL: 'Waterfall',
  AGILE: 'Agile',
};

/**
 * "a", "a and b", "a, b and c". No target hides more than two things today, so
 * the comma branch is unreachable — it exists so a third impact reads as
 * English rather than as a bug.
 */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The clause naming a known count, e.g. "4 sprints already committed".
 *
 * `sprints` reads the configured iteration term (ADR-0111) rather than the word
 * "sprint" — a Hybrid workspace that calls them PIs must not be told it has
 * committed sprints.
 */
function knownClause(kind: FlipImpactKind, count: number, itl: IterationLabelForms): string {
  const one = count === 1;
  switch (kind) {
    case 'sprints':
      return `${count} ${one ? itl.lower : itl.lowerPlural} already committed`;
    case 'backlog':
      return `${count} ${one ? 'item' : 'items'} in the product backlog`;
    case 'tasks':
      // Named for the surface, not the project. AGILE does not hide the tasks —
      // Board and Grid still list every one of them — it hides the two views
      // that place them in time. "64 tasks" would offer a population that is
      // 95% retained as the reason to hesitate.
      return `${count} ${one ? 'task' : 'tasks'} on the schedule`;
    case 'dependencies':
      return `${count} dependency ${one ? 'link' : 'links'}`;
  }
}

/** The same subject with no number, for a read that failed. */
function unknownNoun(kind: FlipImpactKind, itl: IterationLabelForms): string {
  switch (kind) {
    case 'sprints':
      return `${itl.lowerPlural} already committed`;
    case 'backlog':
      return 'items in the product backlog';
    case 'tasks':
      return 'tasks on the schedule';
    case 'dependencies':
      return 'dependency links';
  }
}

/**
 * Consent gate on a methodology flip that would hide data this project already
 * has (issues #2619, #3294).
 *
 * A flip never touches a row — it changes which views the nav offers
 * (`methodologyTabs.ts`). Without this, a team loses the nav entry for work it
 * has already done, with no warning and no signal afterward that the work still
 * exists (the `SprintsView` mismatch banner covers the *after* state; this
 * covers the moment before it happens).
 *
 * **Both directions that hide something are covered, and each names every view
 * it hides.** #2619 shipped the sprint half only: the trigger counted sprints,
 * the copy said "sprints", and the matrix beside it already hid
 * `product-backlog` on the same flip and `schedule` + `calendar` on the mirror
 * one. So a project with 180 groomed stories and no sprints flipped to
 * Waterfall in silence, and a flip to Agile — which takes the Gantt and the
 * Calendar away from a PM whose gates and critical path live there — warned
 * about nothing at all (#3294). The hidden views are read from
 * `hiddenViewsForMethodology` rather than restated here, because the drifted
 * second copy of that list is what caused this.
 *
 * Not a destructive confirm (`variant="primary"`, not `danger`) — nothing is
 * deleted, only hidden from the nav; the data stays reachable by direct URL and,
 * for sprints, via the mismatch banner. `role="alertdialog"` + a focus trap
 * mirror the codebase's other pre-write consent dialogs
 * (`SeedReplaceConfirmDialog`).
 *
 * `pending` is a real phase, not a styling flag (#3298). Confirming disables the
 * very button the user just activated, and a browser blurs a disabled element —
 * so focus lands on `<body>` while an `aria-modal` dialog is still on screen,
 * with the new `Switching…` state announced to nobody. Passing `pending` as
 * `useFocusTrap`'s `focusKey` re-seats focus on the phase change; with both
 * buttons disabled there is no focusable child, so the trap falls back to this
 * container, whose `tabIndex={-1}` + `role="alertdialog"` + `aria-labelledby` /
 * `aria-describedby` re-announce what is happening. This is the multi-state case
 * the hook documents (#1776) — the dialog only became multi-state when it started
 * outliving the confirm click.
 *
 * Re-seating focus re-announces the container's *name and description*, and both
 * are unchanged across the phase swap — so the re-seat on its own announces the
 * same question back, not the new state. The phase therefore writes its own
 * sentence into `#methodology-flip-body`, the node `aria-describedby` already
 * points at; the `Switching…` button label is a visual cue and cannot carry it
 * (it is disabled and no longer focused).
 */
export function MethodologyFlipWarningDialog({
  target,
  impacts,
  itl,
  pending,
  onCancel,
  onConfirm,
}: MethodologyFlipWarningDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    () => {
      if (!pending) onCancel();
    },
    pending,
  );

  const label = TARGET_LABEL[target];
  // Split rather than filter twice so `count` narrows to a number without a
  // non-null assertion.
  const known: Array<{ kind: FlipImpactKind; count: number }> = [];
  const unknown: FlipImpactKind[] = [];
  for (const impact of impacts) {
    if (impact.count === null) unknown.push(impact.kind);
    else known.push({ kind: impact.kind, count: impact.count });
  }
  // `sprints` is the one view whose nav label is the configured iteration term,
  // not its static VIEW_TAB_META label (ADR-0111/0116) — same override the rail
  // applies.
  const hiddenViewLabels = hiddenViewsForMethodology(target).map((view) =>
    view === 'sprints' ? itl.plural : (VIEW_TAB_META[view]?.label ?? view),
  );

  return (
    <div
      ref={trapRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="methodology-flip-title"
      aria-describedby="methodology-flip-body"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="methodology-flip-title"
          className="mb-1 text-base font-semibold text-neutral-text-primary"
        >
          Switch to {label}?
        </h2>
        {/* Every clause below is interpolated into this ONE <p> with no wrapper
            elements: the body is asserted as a single string by both specs, and
            an intermediate <span> would split it across elements. */}
        <p id="methodology-flip-body" className="text-xs text-neutral-text-secondary">
          {/* The phase sentence leads the DESCRIBED node, not the confirm
              button's label. Re-seating focus re-announces this node — so if the
              only thing that changed were a disabled button's text, the write
              starting would be announced to nobody (#3298). */}
          {pending && <>Switching to {label} now. </>}
          {known.length > 0 && (
            <>
              This project has {joinAnd(known.map((i) => knownClause(i.kind, i.count, itl)))}.{' '}
            </>
          )}
          {unknown.length > 0 && (
            <>
              This project may {known.length > 0 ? 'also ' : ''}have{' '}
              {joinAnd(unknown.map((kind) => unknownNoun(kind, itl)))}.{' '}
              {unknown.length === 1
                ? 'That read failed, so the number could not be checked.'
                : 'Those reads failed, so the numbers could not be checked.'}{' '}
            </>
          )}
          {label} hides the {joinAnd(hiddenViewLabels)}{' '}
          {hiddenViewLabels.length === 1 ? 'view' : 'views'} from the nav — nothing is deleted and{' '}
          {hiddenViewLabels.length === 1 ? 'it stays' : 'they stay'} reachable by direct URL, but no
          one will see {hiddenViewLabels.length === 1 ? 'it' : 'them'} from the sidebar until you
          switch back or navigate there directly.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? 'Switching…' : `Switch to ${label}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
