import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { DeliveryMode, GovernanceClass, Task } from '@/types';
import type { ClassificationError } from './useClassificationPopover';
import {
  CLASSIFICATION_PRESETS,
  matchingPreset,
  previewClassification,
  resolveSubtree,
  type ClassificationPresetKey,
} from './classificationPreview';

/**
 * The classification popover — `⌘⇧M` on a row (#2736, ADR-0801).
 *
 * Declares the hybrid split once for a subtree, on the two orthogonal axes the
 * model actually carries. The two axis rows stay visible under the presets on
 * purpose: a preset covers the 90% case, and a blended team that wants
 * `flow + kanban` must not have to learn Scrum vocabulary to say so.
 *
 * **The preview is the feature.** The footer names what will happen before it
 * happens, and it is computed by `previewClassification`, which mirrors the
 * server's own per-row logic. Its two non-obvious claims — that milestones are
 * left alone, and that "overrides kept" is a governance-only number — are the
 * two things a planner would otherwise have to take on faith.
 */

const POPOVER_WIDTH = 400;
const VIEWPORT_PAD = 8;

/** `null` in an axis means "leave this axis alone" — the API allows one axis. */
type GovernanceChoice = GovernanceClass | null;
type DeliveryChoice = DeliveryMode | null;

const GOVERNANCE_OPTIONS: Array<{ value: GovernanceChoice; label: string }> = [
  { value: null, label: 'No change' },
  { value: 'gated', label: 'gated' },
  { value: 'flow', label: 'flow' },
  { value: 'hybrid', label: 'hybrid' },
];

const DELIVERY_OPTIONS: Array<{ value: DeliveryChoice; label: string; disabled?: boolean }> = [
  { value: null, label: 'No change' },
  { value: 'waterfall', label: 'waterfall' },
  { value: 'scrum', label: 'scrum' },
  { value: 'kanban', label: 'kanban' },
  // A cascade cannot convert tasks into gates: `is_milestone`, `duration = 0`
  // and this value are one coupled fact, and the serializer rejects it outright
  // (`TaskClassificationSerializer.validate_delivery_mode`). Shown rather than
  // hidden so the taxonomy stays legible — a value you can see is disabled is
  // less confusing than a value that silently does not exist here.
  { value: 'milestone', label: 'milestone', disabled: true },
];

export interface ClassificationPopoverProps {
  /** Viewport-coordinate anchor — usually the focused row's left edge / top. */
  anchor: { x: number; y: number };
  /** The subtree root. */
  target: Task;
  /** Every task in the project — the preview resolves descendants from this. */
  tasks: Task[];
  isPending: boolean;
  /**
   * The refusal from a failed cascade. Only a `retryable` one switches Apply to
   * "Retry" — see {@link ClassificationError}.
   */
  error: ClassificationError | null;
  onApply: (spec: {
    subtree: string;
    cascade: boolean;
    governance_class: GovernanceClass | null;
    delivery_mode: DeliveryMode | null;
    preserve_governance_overrides: boolean;
    skip_milestones: boolean;
  }) => void;
  onClose: () => void;
}

export function ClassificationPopover({
  anchor,
  target,
  tasks,
  isPending,
  error,
  onApply,
  onClose,
}: ClassificationPopoverProps) {
  const [governanceClass, setGovernanceClass] = useState<GovernanceChoice>(null);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryChoice>(null);
  const [cascade, setCascade] = useState(true);
  const [preserveOverrides, setPreserveOverrides] = useState(true);

  /**
   * A refusal describes the request that was refused, so it goes stale the
   * instant any part of the spec changes — and the cap refusal's copy literally
   * instructs the planner to turn off **Cascade to descendants**, so leaving it
   * up tells them to do the thing they just did while the button beside it has
   * already recomputed to "Apply to task" (#3302).
   *
   * Held here rather than reset through the controller because this component
   * owns the spec: nothing upstream can see the toggle that invalidated it. The
   * render-phase compare is React's derived-state pattern — a new refusal (or the
   * `null` a fresh submit produces) is a different object, which un-suppresses.
   */
  const [lastError, setLastError] = useState<ClassificationError | null>(error);
  const [specEditedSinceError, setSpecEditedSinceError] = useState(false);
  if (error !== lastError) {
    setLastError(error);
    setSpecEditedSinceError(false);
  }
  const visibleError = specEditedSinceError ? null : error;
  const markSpecEdited = () => setSpecEditedSinceError(true);

  const containerRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });

  const descendantCount = useMemo(
    () => Math.max(0, resolveSubtree(tasks, target.id, true).length - 1),
    [tasks, target.id],
  );

  const preview = useMemo(
    () =>
      previewClassification(tasks, {
        subtreeId: target.id,
        cascade,
        governanceClass,
        deliveryMode,
        preserveGovernanceOverrides: preserveOverrides,
        // The cascade never rewrites a milestone's governance from this surface.
        // The flag exists in the API for callers that genuinely mean to, and
        // exposing it here would offer a planner a switch whose only effect is
        // to make gates behave less predictably.
        skipMilestones: true,
      }),
    [tasks, target.id, cascade, governanceClass, deliveryMode, preserveOverrides],
  );

  const activePreset = matchingPreset(governanceClass, deliveryMode);
  const canApply = governanceClass !== null || deliveryMode !== null;

  // Clamp inside the viewport before first paint so the popover never opens
  // half off-screen on a row near the bottom of a tall grid.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width > vw - VIEWPORT_PAD) left = vw - VIEWPORT_PAD - rect.width;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    if (top + rect.height > vh - VIEWPORT_PAD) top = Math.max(VIEWPORT_PAD, vh - VIEWPORT_PAD - rect.height);
    if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;
    setPosition({ top, left });
  }, [anchor.x, anchor.y, containerRef]);

  // Click-outside closes. mousedown (not click) so we fire before an inner
  // control's click handler can run against a popover that is about to unmount.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [containerRef, onClose]);

  // Enter submits from anywhere inside the popover. There is no free-text field
  // here, so Enter has no other sensible meaning — and a radio chip does not
  // submit on Enter by itself, which would otherwise make the keyboard path
  // require a Tab to Apply that the pointer path does not.
  //
  // A ref rather than an effect dependency: `submit` is a fresh closure on every
  // render (it reads six pieces of state), so listing it would rebind the window
  // listener on each keystroke of state change.
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (!containerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      submitRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [containerRef]);

  const applyPreset = (preset: (typeof CLASSIFICATION_PRESETS)[number]) => {
    markSpecEdited();
    setGovernanceClass(preset.governanceClass);
    setDeliveryMode(preset.deliveryMode);
  };

  const chooseGovernance = (v: GovernanceChoice) => {
    markSpecEdited();
    setGovernanceClass(v);
  };

  const chooseDelivery = (v: DeliveryChoice) => {
    markSpecEdited();
    setDeliveryMode(v);
  };

  const submit = () => {
    if (!canApply || isPending) return;
    onApply({
      subtree: target.id,
      cascade,
      governance_class: governanceClass,
      delivery_mode: deliveryMode,
      preserve_governance_overrides: preserveOverrides,
      skip_milestones: true,
    });
  };
  submitRef.current = submit;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label="Classification"
      data-testid="classification-popover"
      tabIndex={-1}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className="fixed z-50 rounded-card border border-neutral-border bg-neutral-surface
                 shadow-pop text-xs text-neutral-text-primary"
    >
      <div className="px-4 pt-3 pb-2 border-b border-neutral-border">
        <h2 className="text-sm font-semibold">Classification</h2>
        <p className="mt-1 text-neutral-text-secondary leading-snug">
          Applies to <span className="font-medium text-neutral-text-primary">{target.name}</span>
          {cascade && descendantCount > 0
            ? ` and its ${descendantCount} descendant${descendantCount === 1 ? '' : 's'}.`
            : ' only.'}{' '}
          Two fields, because the model has two — collapsing them mis-tags every Kanban team.
        </p>
      </div>

      <div className="px-4 py-3 space-y-3">
        <AxisRow label="Preset" note="writes both fields">
          {CLASSIFICATION_PRESETS.map((preset) => (
            <ChipButton
              key={preset.key}
              selected={activePreset === preset.key}
              onClick={() => applyPreset(preset)}
              testId={`classification-preset-${preset.key}`}
            >
              {preset.label}
            </ChipButton>
          ))}
        </AxisRow>

        <AxisRadioRow
          name="governance_class"
          label="Governed by"
          note="GovernanceClass"
          options={GOVERNANCE_OPTIONS}
          value={governanceClass}
          onChange={chooseGovernance}
        />

        <AxisRadioRow
          name="delivery_mode"
          label="Progress from"
          note="DeliveryMode"
          options={DELIVERY_OPTIONS}
          value={deliveryMode}
          onChange={chooseDelivery}
          disabledTitle="A cascade cannot convert tasks into milestones — set is_milestone on the task itself."
        />

        <p className="text-neutral-text-secondary leading-snug">
          Scrum rolls up from point burndown and feeds the velocity distribution in Monte Carlo.
          Kanban rolls up from item throughput. Blended teams pick per subtree — that is the common
          case, not the edge case.
        </p>

        <div className="flex flex-col gap-1.5 pt-1 border-t border-neutral-border">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => {
                markSpecEdited();
                setCascade(e.target.checked);
              }}
              data-testid="classification-cascade"
            />
            <span>
              Cascade to descendants
              {descendantCount > 0 ? ` (${descendantCount})` : ''}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={preserveOverrides}
              onChange={(e) => {
                markSpecEdited();
                setPreserveOverrides(e.target.checked);
              }}
              disabled={governanceClass === null}
              data-testid="classification-preserve-overrides"
            />
            {/* Default on, and that default is what makes cascading safe to try:
                a hand-tuned compliance branch inside an otherwise agile phase
                survives a re-declaration of the phase. */}
            <span className={governanceClass === null ? 'text-neutral-text-secondary' : ''}>
              Keep explicit governance overrides
            </span>
          </label>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-neutral-border">
        {/* A sibling of the preview, not a child of it: `role="status"` carries an
            implicit `aria-atomic="true"`, so an error appended inside it makes AT
            re-read the whole preview before the refusal — and nesting `role="alert"`
            inside `role="status"` risks a double announcement instead. Full width so
            a two-line refusal is not squeezed into the ~174px column beside the
            buttons. Same anatomy as `ScheduleCommitPopover` (#3302). */}
        {visibleError && (
          <div
            role="alert"
            className="mb-2 leading-snug text-semantic-critical"
            data-testid="classification-error"
          >
            <div>{visibleError.message}</div>
            {visibleError.detail && <div className="mt-1">{visibleError.detail}</div>}
          </div>
        )}
        <div className="flex items-start gap-3">
          <div
            role="status"
            aria-live="polite"
            className="flex-1 leading-snug text-neutral-text-secondary"
            data-testid="classification-preview"
          >
            {canApply ? (
              <>
                <div className="text-neutral-text-primary font-medium">
                  {preview.tasksChanged} task{preview.tasksChanged === 1 ? '' : 's'} change
                </div>
                {preview.milestonesSkipped > 0 && (
                  <div>
                    <span className="text-neutral-text-primary font-medium">
                      {preview.milestonesSkipped} milestone
                      {preview.milestonesSkipped === 1 ? '' : 's'} unchanged
                    </span>{' '}
                    — a gate is not a delivery mode
                  </div>
                )}
                {preview.governance && (
                  <div>{preview.governance.overridesKept} governance overrides kept</div>
                )}
                {preview.deliveryMode && (
                  <div>
                    <code>delivery_mode</code> has no inherit bit
                  </div>
                )}
              </>
            ) : (
              <span>Choose a preset, or a value on either axis.</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canApply || isPending}
              onClick={submit}
              data-testid="classification-apply"
            >
              {/* A refused 4xx keeps the Apply label: the way forward is to change
                  the scope or the axis and submit again, not to resend a request
                  the server has already decided on (#3302). */}
              {visibleError?.retryable ? 'Retry' : cascade ? 'Apply to subtree' : 'Apply to task'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AxisRow({
  label,
  note,
  children,
}: {
  label: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="w-24 shrink-0 text-neutral-text-secondary">{label}</span>
      {children}
      <span className="ml-auto font-mono text-neutral-text-secondary">{note}</span>
    </div>
  );
}

/**
 * One axis as a native radio group.
 *
 * Native `<input type="radio">` rather than `role="radio"` buttons: arrow-key
 * traversal, group semantics and the "one of these is selected" announcement
 * all come from the platform, and a chip is only a visual treatment of a radio.
 */
function AxisRadioRow<V extends string | null>({
  name,
  label,
  note,
  options,
  value,
  onChange,
  disabledTitle,
}: {
  name: string;
  label: string;
  note: string;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
  value: V;
  onChange: (v: V) => void;
  disabledTitle?: string;
}) {
  return (
    <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
        {label}
      </span>
      {options.map((opt) => {
        const checked = opt.value === value;
        return (
          <label
            key={opt.label}
            title={opt.disabled ? disabledTitle : undefined}
            className={[
              'inline-flex items-center rounded-chip border px-2 py-0.5 cursor-pointer',
              'focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1',
              opt.disabled ? 'opacity-50 cursor-not-allowed' : '',
              checked
                ? 'border-brand-primary bg-brand-primary/10 text-brand-primary font-medium'
                : 'border-neutral-border text-neutral-text-secondary',
            ].join(' ')}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              checked={checked}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        );
      })}
      <span className="ml-auto font-mono text-neutral-text-secondary">{note}</span>
    </fieldset>
  );
}

function ChipButton({
  selected,
  onClick,
  children,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      data-testid={testId}
      className={[
        'inline-flex items-center rounded-chip border px-2 py-0.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        selected
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary font-medium'
          : 'border-neutral-border text-neutral-text-secondary hover:border-brand-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export type { ClassificationPresetKey };
