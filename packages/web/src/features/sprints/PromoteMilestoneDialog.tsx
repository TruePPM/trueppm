import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/Button';
import {
  CalendarIcon,
  GanttIcon,
  PlusIcon,
  SearchIcon,
  WarningIcon,
} from '@/components/Icons';
import {
  isSprintAlreadyBound,
  useMilestoneCandidates,
  usePromoteSprintToMilestone,
  useReforecastPreview,
  useUnbindSprintMilestone,
  type MilestoneCandidate,
  type ReforecastPreview,
} from '@/hooks/usePromoteMilestone';
import type { ApiSprint } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { IterationLabelForms } from '@/lib/iterationLabel';
import { formatShortDate } from './sprintMath';

/**
 * DA-02 — Promote a sprint commitment to a schedule milestone (ADR-0106 §2).
 *
 * One responsive component covers all three design variants:
 *   • Variant B (showpiece, ≥ lg): a two-column promote form + a live reforecast
 *     preview, so the user sees the projected CPM-finish range before binding.
 *   • Variant A (compact): below `lg`, or when `compact`/quick-mode is on, the
 *     preview column drops and the form renders as the lighter single-column
 *     dialog — A is B's small-surface rendering, not a separate dialog (VoC:
 *     carry B forward, A as its responsive/collapsed state).
 *   • 409 already-bound: when the sprint is already bound (on open, or a race
 *     surfaces `sprint_already_bound`), the conflict view offers keep / unbind /
 *     rebind — a commitment advances one milestone at a time; rebind is audited.
 *
 * Velocity privacy (Morgan, ADR-0106): the velocity figure is framed as the
 * team's *pace* feeding this milestone's forecast — never surfaced as a raw
 * management gauge. The binding write is recorded in the sprint's history; the
 * footer says so honestly rather than decorating an "audited" claim.
 *
 * Gating: promote is a schedule-authoring write (role ≥ SCHEDULER, ADR-0106 §2),
 * enforced server-side. This dialog is only opened from planning surfaces; it
 * does not mount in the contributor tree.
 */
export interface PromoteMilestoneDialogProps {
  projectId: string;
  sprint: ApiSprint;
  onClose: () => void;
  /** Fired with the updated sprint after a successful bind/unbind. */
  onBound?: (sprint: ApiSprint) => void;
  /** Force the compact (variant A) layout regardless of viewport — for drawer
   *  and inline callers that have no room for the preview column. */
  compact?: boolean;
}

type Mode = 'create' | 'bind';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Flag glyph — local to keep the shared Icons.tsx free of a same-name collision
 *  with the parallel DA-01 bridge-banner work. */
function FlagIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="3.5" y1="1.5" x2="3.5" y2="14.5" />
      <path d="M3.5 2.5h8l-1.6 2.5L11.5 7.5h-8z" />
    </svg>
  );
}

/** The milestone name a `{}` create will produce (ADR-0106 §2: from goal, else
 *  "<sprint name> milestone"). Rendered as a read-only preview because the
 *  create body carries no overrides. */
function derivedMilestoneName(sprint: ApiSprint): string {
  const goal = sprint.goal?.trim();
  return goal && goal.length > 0 ? goal : `${sprint.name} milestone`;
}

export function PromoteMilestoneDialog({
  projectId,
  sprint,
  onClose,
  onBound,
  compact = false,
}: PromoteMilestoneDialogProps) {
  const itl = useIterationLabel(projectId);
  const alreadyBound = sprint.target_milestone != null;

  // View state: the conflict view shows whenever the sprint is bound and the
  // user has not chosen to rebind. A 409 race flips `conflict` back on.
  const [rebinding, setRebinding] = useState(false);
  const [conflict, setConflict] = useState(alreadyBound);
  const showForm = !conflict || rebinding;

  const [mode, setMode] = useState<Mode>('create');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Quick mode hides the preview column at lg+ (repeat-bind ergonomics — Alex/
  // Jordan/David convergence). Below lg the preview is always hidden anyway.
  const [quickMode, setQuickMode] = useState(compact);
  // Create-mode editable overrides (ADR-0106 §E1.2, #933): prefilled with the
  // backend defaults (goal-derived name, sprint finish date) so leaving them
  // untouched reproduces the plain `{}` create; clearing the name falls back to
  // the goal default server-side.
  const [createName, setCreateName] = useState(() => derivedMilestoneName(sprint));
  const [createTargetDate, setCreateTargetDate] = useState(sprint.finish_date);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const firstFieldRef = useRef<HTMLButtonElement>(null);

  const promote = usePromoteSprintToMilestone(projectId);
  const unbind = useUnbindSprintMilestone(projectId);
  const { candidates, isLoading: candidatesLoading } = useMilestoneCandidates(
    projectId,
    sprint.target_milestone,
  );

  // Capture trigger on open; restore focus on unmount. Focus the first form
  // control when the form renders, else the first focusable in the conflict
  // view (firstFieldRef only exists on the form path).
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const target =
      firstFieldRef.current ??
      (dialogRef.current ? getFocusable(dialogRef.current)[0] : null);
    target?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Escape closes; Tab cycles within the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Create mode always has a target (the sprint finish); bind mode needs a
  // selected milestone before the dry-run preview can resolve.
  const hasTarget = mode === 'create' || selectedId != null;
  const showPreview = !quickMode;
  const { preview } = useReforecastPreview(
    sprint.id,
    mode === 'bind' ? selectedId : null,
    showPreview && hasTarget,
  );

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const busy = promote.isPending || unbind.isPending;
  const canSubmit =
    !busy && !offline && (mode === 'create' || selectedId != null);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) => c.name.toLowerCase().includes(q) || c.wbs.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  function handlePromote() {
    if (!canSubmit) return;
    const milestoneId = mode === 'bind' ? selectedId : null;
    const run = () =>
      promote.mutate(
        {
          sprintId: sprint.id,
          milestoneId,
          // Create-mode overrides ride only the create path; the hook ignores
          // them when milestoneId is set (and the backend does too, §E1.2).
          name: mode === 'create' ? createName : undefined,
          targetDate: mode === 'create' ? createTargetDate : undefined,
        },
        {
          onSuccess: (updated) => {
            onBound?.(updated);
            onClose();
          },
          onError: (err) => {
            if (isSprintAlreadyBound(err)) {
              // Lost a race — surface the conflict view instead of a raw error.
              setRebinding(false);
              setConflict(true);
            }
          },
        },
      );
    // Rebinding: unbind first (binding never silently re-points — ADR-0106 §2),
    // then promote to the new target.
    if (rebinding && alreadyBound) {
      unbind.mutate(
        { sprintId: sprint.id },
        { onSuccess: () => run() },
      );
      return;
    }
    run();
  }

  function handleUnbind() {
    unbind.mutate(
      { sprintId: sprint.id },
      {
        onSuccess: (updated) => {
          onBound?.(updated);
          onClose();
        },
      },
    );
  }

  const widthClass = quickMode || conflict ? 'max-w-md' : 'max-w-md lg:max-w-3xl';

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-50 bg-black/40 cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={
            conflict && !rebinding
              ? `${itl.singular} already bound to a milestone`
              : `Promote ${itl.lower} to milestone`
          }
          className={`w-full ${widthClass} max-h-[90vh] overflow-auto rounded-lg border border-neutral-border bg-neutral-surface pointer-events-auto`}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-neutral-border p-5">
            <div className="flex flex-col gap-1 min-w-0">
              <h2 className="text-base font-semibold text-neutral-text-primary">
                {conflict && !rebinding
                  ? 'Already bound to a milestone'
                  : 'Promote to milestone'}
              </h2>
              <p className="text-xs text-neutral-text-secondary leading-relaxed">
                {conflict && !rebinding
                  ? `A ${itl.lower} commitment advances one milestone at a time. Rebinding is recorded in the ${itl.lower} history.`
                  : `Link ${sprint.short_id_display}'s commitment to a schedule milestone so its velocity reforecasts the CPM finish — no copy-paste between tools.`}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {showForm && !compact && (
                <button
                  type="button"
                  onClick={() => setQuickMode((q) => !q)}
                  aria-pressed={quickMode}
                  className="hidden lg:inline-flex h-7 items-center rounded px-2 text-xs font-medium text-neutral-text-secondary
                    hover:text-neutral-text-primary border border-neutral-border
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  {quickMode ? 'Show forecast' : 'Quick mode'}
                </button>
              )}
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="h-7 w-7 inline-flex items-center justify-center rounded text-neutral-text-disabled
                  hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                <span aria-hidden="true" className="text-lg leading-none">×</span>
              </button>
            </div>
          </div>

          {/* Body */}
          {conflict && !rebinding ? (
            <ConflictBody
              sprint={sprint}
              busy={busy}
              iterationLower={itl.lower}
              onClose={onClose}
              onUnbind={handleUnbind}
              onRebind={() => {
                setRebinding(true);
                setConflict(false);
              }}
            />
          ) : (
            <div
              className={
                showPreview
                  ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]'
                  : ''
              }
            >
              {/* Left — the form */}
              <div className="flex flex-col gap-4 p-5">
                {rebinding && (
                  <p
                    role="status"
                    className="flex items-center gap-2 rounded-md bg-semantic-at-risk-bg px-3 py-2 text-xs text-semantic-at-risk"
                  >
                    <WarningIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                    Rebinding moves the reforecast off the current milestone. The old
                    milestone reverts to its CPM-only forecast.
                  </p>
                )}

                {/* create-vs-bind segmented control */}
                <div
                  role="group"
                  aria-label="Milestone source"
                  className="inline-flex gap-1 rounded-lg border border-neutral-border bg-neutral-surface-sunken p-1 self-start"
                >
                  <ModeButton
                    ref={firstFieldRef}
                    active={mode === 'create'}
                    onClick={() => setMode('create')}
                  >
                    <PlusIcon className="h-3 w-3" aria-hidden="true" />
                    Create new
                  </ModeButton>
                  <ModeButton active={mode === 'bind'} onClick={() => setMode('bind')}>
                    <FlagIcon className="h-3 w-3" />
                    Bind existing
                  </ModeButton>
                </div>

                {mode === 'create' ? (
                  <CreateModeBody
                    name={createName}
                    onNameChange={setCreateName}
                    targetDate={createTargetDate}
                    onTargetDateChange={setCreateTargetDate}
                    iterationLower={itl.lower}
                  />
                ) : (
                  <BindModeBody
                    candidates={filteredCandidates}
                    isLoading={candidatesLoading}
                    search={search}
                    onSearch={setSearch}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </div>

              {/* Right — live reforecast preview (variant B, ≥ lg only) */}
              {showPreview && (
                <div className="hidden lg:flex flex-col gap-3 border-l border-neutral-border bg-neutral-surface-sunken p-5">
                  <ReforecastPreviewPanel
                    preview={preview}
                    hasTarget={hasTarget}
                    mode={mode}
                    label={itl}
                  />
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          {showForm && (
            <div className="flex items-center gap-3 border-t border-neutral-border p-4">
              <p className="flex-1 text-xs text-neutral-text-secondary tppm-mono">
                Reforecasts on {itl.lower} close · recorded in history
              </p>
              <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={handlePromote}
                disabled={!canSubmit}
                title={offline ? "You're offline — binding needs a connection." : undefined}
              >
                <FlagIcon className="h-3 w-3" />
                {busy
                  ? 'Binding…'
                  : mode === 'create'
                    ? 'Create & bind'
                    : 'Bind & reforecast'}
              </Button>
            </div>
          )}

          {(promote.isError && !isSprintAlreadyBound(promote.error)) || unbind.isError ? (
            <p role="alert" className="px-5 pb-4 text-xs text-semantic-critical">
              Couldn’t update the milestone binding. Please try again.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ModeButtonProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}
const ModeButton = forwardRef<HTMLButtonElement, ModeButtonProps>(function ModeButton(
  { active, onClick, children },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
        ${
          active
            ? 'bg-neutral-surface text-neutral-text-primary border border-neutral-border'
            : 'text-neutral-text-secondary border border-transparent hover:text-neutral-text-primary'
        }`}
    >
      {children}
    </button>
  );
});

/** Create mode — editable name + target date for the `{}` create (ADR-0106 §E1.2,
 *  #933). Prefilled with the backend defaults (goal-derived name, sprint finish);
 *  a blank name falls back to the goal default server-side, and any valid target
 *  date is accepted (it sets the milestone's planned_start floor). */
function CreateModeBody({
  name,
  onNameChange,
  targetDate,
  onTargetDateChange,
  iterationLower,
}: {
  name: string;
  onNameChange: (v: string) => void;
  targetDate: string;
  onTargetDateChange: (v: string) => void;
  iterationLower: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
          New milestone
        </span>
        <span className="flex items-center gap-2 rounded-md border border-neutral-border bg-neutral-surface px-3 h-9 focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1">
          <FlagIcon className="h-3.5 w-3.5 shrink-0 text-brand-primary" />
          <input
            type="text"
            value={name}
            maxLength={255}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Milestone name"
            className="flex-1 bg-transparent text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
              focus-visible:outline-none"
          />
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
          Target date
        </span>
        <span className="flex items-center gap-2 rounded-md border border-neutral-border bg-neutral-surface px-3 h-9 focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1">
          <CalendarIcon
            className="h-3.5 w-3.5 shrink-0 text-neutral-text-secondary"
            aria-hidden="true"
          />
          <input
            type="date"
            value={targetDate}
            onChange={(e) => onTargetDateChange(e.target.value)}
            className="flex-1 bg-transparent text-sm text-neutral-text-primary tppm-mono
              focus-visible:outline-none"
          />
        </span>
      </label>
      <p className="text-xs text-neutral-text-secondary leading-relaxed">
        Defaults to the {iterationLower}’s goal and finish date — edit either here, or move
        the milestone in the Schedule view later.
      </p>
    </div>
  );
}

interface BindModeBodyProps {
  candidates: MilestoneCandidate[];
  isLoading: boolean;
  search: string;
  onSearch: (v: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}
function BindModeBody({
  candidates,
  isLoading,
  search,
  onSearch,
  selectedId,
  onSelect,
}: BindModeBodyProps) {
  // Arrow/Home/End move selection among radios (the focused radio handles its
  // own keys — keeping the keydown off the group container, which must not be a
  // tab stop in a roving-tabindex radio group).
  function handleRadioKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key) || candidates.length === 0) return;
    e.preventDefault();
    const current = candidates.findIndex((c) => c.id === selectedId);
    const base = current < 0 ? 0 : current;
    let next = base;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (base + 1) % candidates.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = (base - 1 + candidates.length) % candidates.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = candidates.length - 1;
    onSelect(candidates[next].id);
    const group = e.currentTarget.closest('[role="radiogroup"]');
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
          Schedule milestone
        </span>
        <span className="flex items-center gap-2 rounded-md border border-neutral-border bg-neutral-surface px-3 h-9 focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-text-secondary" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search milestones by name or WBS"
            className="flex-1 bg-transparent text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
              focus-visible:outline-none"
          />
        </span>
      </label>

      <div
        role="radiogroup"
        aria-label="Select a milestone to bind"
        className="flex flex-col gap-1.5 max-h-56 overflow-auto"
      >
        {isLoading ? (
          <p className="px-1 py-2 text-xs text-neutral-text-secondary">Loading milestones…</p>
        ) : candidates.length === 0 ? (
          <p role="status" className="px-1 py-2 text-xs text-neutral-text-secondary">
            No other milestones in this project. Use “Create new” to add one.
          </p>
        ) : (
          candidates.map((m, i) => {
            const on = m.id === selectedId;
            // Roving tabindex: one tab stop into the group lands on the selected
            // radio (or the first when none is selected); arrows move from there.
            const rove = on || (selectedId == null && i === 0);
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={rove ? 0 : -1}
                onClick={() => onSelect(m.id)}
                onKeyDown={handleRadioKeyDown}
                className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  ${
                    on
                      ? 'border-brand-primary bg-brand-primary-light'
                      : 'border-neutral-border bg-neutral-surface hover:bg-neutral-surface-sunken'
                  }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border
                    ${on ? 'border-brand-primary bg-brand-primary' : 'border-neutral-border'}`}
                >
                  {on && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <span className="flex items-center gap-1.5 shrink-0 text-brand-primary">
                  <FlagIcon className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate text-sm font-medium text-neutral-text-primary">
                  {m.name}
                </span>
                {m.wbs && (
                  <span className="tppm-mono text-xs text-neutral-text-secondary">WBS {m.wbs}</span>
                )}
                {m.finish && (
                  <span className="tppm-mono text-xs font-medium text-neutral-text-primary">
                    {formatShortDate(m.finish)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Variant B's right column. Renders the projected reforecast when a preview is
 *  available, and an honest "reforecasts on close" note otherwise. The velocity
 *  figure is framed as team *pace* feeding the forecast (Morgan / ADR-0106). */
function ReforecastPreviewPanel({
  preview,
  hasTarget,
  mode,
  label,
}: {
  preview: ReforecastPreview | null;
  hasTarget: boolean;
  mode: Mode;
  label: IterationLabelForms;
}) {
  return (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
        <GanttIcon className="h-3 w-3" aria-hidden="true" />
        CPM finish · projected
      </span>

      {!hasTarget ? (
        <p className="text-xs text-neutral-text-secondary leading-relaxed">
          {mode === 'bind'
            ? `Select a milestone to preview how this ${label.lower}’s pace reforecasts its finish.`
            : `A reforecast appears once the ${label.lower} window is set.`}
        </p>
      ) : !preview ? (
        <p className="text-xs text-neutral-text-secondary leading-relaxed">
          This {label.lower}’s velocity reforecasts the milestone finish as a range when the
          {' '}{label.lower} closes. The range is recorded in the {label.lower} history.
        </p>
      ) : (
        <>
          {/* before / after — color tracks whether P80 lands by the committed
              date, so a slipping reforecast never reads as good news. */}
          {(() => {
            const hit = preview.p80 <= preview.cpmFinish;
            return (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-text-secondary">CPM-only (today)</span>
                  <span className="tppm-mono font-semibold text-neutral-text-disabled">
                    {formatShortDate(preview.cpmFinish)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-neutral-text-primary">With this {label.lower}’s pace</span>
                  <span
                    className={`tppm-mono font-bold ${hit ? 'text-semantic-on-track' : 'text-semantic-at-risk'}`}
                  >
                    {formatShortDate(preview.p80)}{' '}
                    <span className="font-medium text-neutral-text-disabled">
                      {deltaLabel(preview.cpmFinish, preview.p80)}
                    </span>
                  </span>
                </div>
              </div>
            );
          })()}

          <PercentileBar preview={preview} />

          {preview.teamPaceLow != null && preview.teamPaceHigh != null ? (
            <p className="text-xs text-neutral-text-secondary leading-relaxed">
              Team pace of{' '}
              <span className="tppm-mono font-medium text-neutral-text-primary">
                {preview.teamPaceLow}–{preview.teamPaceHigh} pts
              </span>{' '}
              per {label.lower} feeds this milestone’s forecast. Projection — the committed
              range is set on close.
            </p>
          ) : (
            <p className="text-xs text-neutral-text-secondary leading-relaxed">
              Not enough closed {label.lowerPlural} yet for a team-pace band — the range is set
              on close as velocity accrues.
            </p>
          )}

          {preview.unmodeledDependency && (
            <p className="flex items-start gap-1.5 rounded-md bg-semantic-at-risk-bg px-2.5 py-2 text-xs text-semantic-at-risk">
              <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              Excludes an upstream item not in this {label.lower} — the range may be optimistic.
            </p>
          )}
        </>
      )}
    </>
  );
}

/** Signed day delta between two ISO dates, e.g. "−2d" / "+3d". */
function deltaLabel(fromIso: string, toIso: string): string {
  const ms =
    new Date(toIso + 'T00:00:00Z').getTime() - new Date(fromIso + 'T00:00:00Z').getTime();
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return '0d';
  return days > 0 ? `+${days}d` : `${days}d`;
}

/** A compact P50–P95 band with the P80 marker and the committed-date tick. */
function PercentileBar({ preview }: { preview: ReforecastPreview }) {
  const dates = [preview.p50, preview.p80, preview.p95, preview.cpmFinish]
    .filter(Boolean)
    .map((d) => new Date(d + 'T00:00:00Z').getTime());
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const span = Math.max(1, max - min);
  const pct = (iso: string) =>
    ((new Date(iso + 'T00:00:00Z').getTime() - min) / span) * 100;

  const p50 = pct(preview.p50);
  const p80 = pct(preview.p80);
  const p95 = pct(preview.p95);
  const committed = pct(preview.cpmFinish);
  const hit = preview.p80 <= preview.cpmFinish;
  // Literal class strings — Tailwind's JIT cannot see interpolated names.
  const bandClass = hit
    ? 'bg-semantic-on-track-bg border-semantic-on-track'
    : 'bg-semantic-at-risk-bg border-semantic-at-risk';
  const markerClass = hit ? 'bg-semantic-on-track' : 'bg-semantic-at-risk';
  const labelClass = hit ? 'text-semantic-on-track' : 'text-semantic-at-risk';

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface p-3">
      <div className="relative h-10">
        {/* track */}
        <div className="absolute inset-x-0 top-4 h-1.5 rounded-full bg-neutral-surface-sunken" />
        {/* P50–P95 band */}
        <div
          className={`absolute top-[13px] h-2.5 rounded-full border ${bandClass}`}
          style={{ left: `${p50}%`, right: `${100 - p95}%` }}
        />
        {/* P80 marker */}
        <div
          className={`absolute top-2 h-4 w-0.5 ${markerClass}`}
          style={{ left: `${p80}%` }}
        />
        <span
          className={`absolute -top-0.5 tppm-mono text-xs font-bold ${labelClass} -translate-x-1/2`}
          style={{ left: `${p80}%` }}
        >
          P80
        </span>
        {/* committed-date tick */}
        <div
          className="absolute top-1.5 h-5 border-l border-dashed border-neutral-text-primary"
          style={{ left: `${committed}%` }}
        />
      </div>
      <div className="flex justify-between tppm-mono text-xs text-neutral-text-disabled">
        <span>P50 {formatShortDate(preview.p50)}</span>
        <span>P80 {formatShortDate(preview.p80)}</span>
        <span>P95 {formatShortDate(preview.p95)}</span>
      </div>
    </div>
  );
}

/** 409 already-bound conflict view: keep / unbind / rebind. */
function ConflictBody({
  sprint,
  busy,
  iterationLower,
  onClose,
  onUnbind,
  onRebind,
}: {
  sprint: ApiSprint;
  busy: boolean;
  iterationLower: string;
  onClose: () => void;
  onUnbind: () => void;
  onRebind: () => void;
}) {
  const detail = sprint.target_milestone_detail;
  return (
    <>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3 rounded-md border border-semantic-at-risk/80 bg-semantic-at-risk-bg p-3">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-semantic-at-risk" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-neutral-text-primary">
            {sprint.short_id_display} is bound to{' '}
            <span className="font-semibold">{detail?.name ?? 'a milestone'}</span>. Rebinding moves
            the velocity reforecast to a new target and reverts the old milestone to its
            CPM-only forecast. The change is recorded in the {iterationLower} history.
          </p>
        </div>

        {detail && (
          <div className="flex flex-col gap-1 rounded-md border border-neutral-border bg-neutral-surface p-3">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-disabled">
              Current milestone
            </span>
            <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-text-primary">
              <FlagIcon className="h-3.5 w-3.5 text-brand-primary" />
              {detail.name}
            </span>
            <span className="flex items-center gap-2 tppm-mono text-xs text-neutral-text-secondary">
              {detail.wbs_path && <span>WBS {detail.wbs_path}</span>}
              {detail.finish && <span>{formatShortDate(detail.finish)}</span>}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-neutral-border p-4">
        <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
          Keep current binding
        </Button>
        <Button variant="secondary" size="md" onClick={onUnbind} disabled={busy}>
          {busy ? 'Working…' : 'Unbind'}
        </Button>
        <Button variant="primary" size="md" onClick={onRebind} disabled={busy}>
          Rebind to another…
        </Button>
      </div>
    </>
  );
}
