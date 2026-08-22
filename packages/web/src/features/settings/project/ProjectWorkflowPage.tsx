import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  SettingsPageTitle,
  SettingsSubHeading,
  type SettingsBlockProps,
} from '../SettingsShell';
import { ReadOnlyIndicator } from '../components/ReadOnlyIndicator';
import { Toggle } from '../components/Toggle';
import { FieldHelp, type FieldHelpOption } from '@/components/FieldHelp';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { BUILT_IN_FIELDS } from './builtInFields';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useActiveSprint } from '@/hooks/useSprints';
import {
  useBoardConfig,
  COLUMN_SLA_DEFAULTS,
  type BoardColumnDef,
  type BoardLaneDef,
} from '@/hooks/useBoardConfig';
import { MAX_LANES_PER_COLUMN, uniqueLaneKey } from '@/features/board/statusLanes';
import { useProjectPhases, type ProjectPhase } from '@/hooks/useProjectPhases';
import type { BoardCadence } from '@/types';
import {
  useProjectCustomFields,
  type CustomFieldOption,
  type CustomFieldType,
  type ProjectCustomField,
} from '@/hooks/useProjectCustomFields';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { Link } from 'react-router';

// Preset palette for phase & status colors. Limited so a settings page stays
// approachable; "More colors" via free-form hex is intentionally not exposed
// in 0.2 — keeps the picker keyboard-accessible without a complex popover.
const COLOR_SWATCHES = [
  '#3E8C6D',
  '#C17A10',
  '#7C3AED',
  '#0EA5E9',
  '#DC2626',
  '#16A34A',
  '#6B6965',
  '#94A3B8',
] as const;

// Human-readable names so the swatch buttons announce "Set phase color to
// Sage" rather than "Set phase color to #3E8C6D" (WCAG 2.4.6 / 4.1.2).
const COLOR_SWATCH_NAMES: Record<(typeof COLOR_SWATCHES)[number], string> = {
  '#3E8C6D': 'Sage',
  '#C17A10': 'Amber',
  '#7C3AED': 'Violet',
  '#0EA5E9': 'Sky blue',
  '#DC2626': 'Red',
  '#16A34A': 'Green',
  '#6B6965': 'Slate gray',
  '#94A3B8': 'Cool gray',
};

const CUSTOM_FIELD_TYPE_OPTIONS: Array<{ value: CustomFieldType; label: string }> = [
  { value: 'TEXT', label: 'Text' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'DATE', label: 'Date' },
  { value: 'SINGLE_SELECT', label: 'Single-select' },
  { value: 'MULTI_SELECT', label: 'Multi-select' },
  { value: 'USER', label: 'Person' },
  { value: 'BOOLEAN', label: 'Boolean' },
];

function isSelectType(t: CustomFieldType): boolean {
  return t === 'SINGLE_SELECT' || t === 'MULTI_SELECT';
}

// Plain-language gloss of each custom-field type for the "Field type" FieldHelp
// popover (web-rule 263). Mirrors CUSTOM_FIELD_TYPE_OPTIONS so the ⓘ never
// invents a type the create modal doesn't offer.
const CUSTOM_FIELD_TYPE_HELP: FieldHelpOption[] = [
  { label: 'Text', desc: 'Free-form single-line text.' },
  { label: 'Number', desc: 'A numeric value.' },
  { label: 'Date', desc: 'A calendar date.' },
  { label: 'Single-select', desc: 'One choice from a fixed list of options you define.' },
  { label: 'Multi-select', desc: 'Any number of choices from a fixed list of options.' },
  { label: 'Person', desc: 'A project member.' },
  { label: 'Boolean', desc: 'A yes / no checkbox.' },
];

/** Project > Workflow & fields settings page (#521). */
export function ProjectWorkflowPage({ embedded, docsHref }: SettingsBlockProps = {}) {
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId);
  const canEditPhases = role !== null && role >= ROLE_ADMIN;
  const canEditStatusesOrFields = role !== null && role >= ROLE_SCHEDULER;

  return (
    <div>
      <SettingsPageTitle
        embedded={embedded}
        docsHref={docsHref}
        title="Workflow & fields"
        subtitle="Phases, statuses, and custom fields. These shape every Board, Schedule, and Table view in this project."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        <CadenceSection projectId={projectId} canEdit={canEditStatusesOrFields} />
        <PhasesSection projectId={projectId} canEdit={canEditPhases} />
        <StatusesSection projectId={projectId} canEdit={canEditStatusesOrFields} />
        <FieldsSection projectId={projectId} canEdit={canEditStatusesOrFields} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board cadence section (issue 410, ADR-0164)
// ---------------------------------------------------------------------------

const CADENCE_OPTIONS: Array<{ id: BoardCadence; label: string; desc: string }> = [
  {
    id: 'sprint',
    label: 'Sprint-based',
    desc: 'Plan and track work in time-boxed sprints with a burndown.',
  },
  {
    id: 'continuous',
    label: 'Continuous flow (Kanban)',
    desc: 'No sprint cadence — work flows through columns; the board surfaces flow analytics.',
  },
];

/**
 * Board cadence picker (ADR-0164). Orthogonal to methodology: only shown for
 * AGILE/HYBRID projects (WATERFALL already hides sprints). Persists immediately on
 * select — consistent with the rest of this page. Scheduler+ gated.
 */
function CadenceSection({
  projectId,
  canEdit,
}: {
  projectId: string | undefined;
  canEdit: boolean;
}) {
  const { data: project, isLoading } = useProject(projectId ?? null);
  const update = useUpdateProject(projectId ?? null);
  const { sprint: activeSprint } = useActiveSprint(projectId ?? null);

  const selected: BoardCadence = project?.board_cadence ?? 'sprint';
  const isWaterfall = project?.methodology === 'WATERFALL';

  // Roving tabindex for the radio-card group (rule 167 / WCAG 2.1.1): the group is
  // one tab stop; arrow keys move focus only (never commit — activation saves), and
  // the focused option mirrors the current selection.
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = CADENCE_OPTIONS.findIndex((o) => o.id === selected);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  const onRadioKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canEdit) return;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = Math.min(CADENCE_OPTIONS.length - 1, focusIdx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = Math.max(0, focusIdx - 1);
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = CADENCE_OPTIONS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    setFocusIdx(next);
    btnRefs.current[next]?.focus(); // move focus only — do NOT commit
  };

  return (
    <section
      aria-labelledby="cadence-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
        <SettingsSubHeading id="cadence-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Board cadence
        </SettingsSubHeading>
        <FieldHelp
          label="Board cadence"
          body="Cadence is how this board paces work. Sprint-based plans work in time-boxed sprints with a burndown; continuous flow (Kanban) drops the sprint cadence and tracks work as it moves through columns, surfacing flow analytics instead. Switching to continuous flow hides sprint tracking but preserves the sprint data."
          docHref="features/board/#board-cadence"
        />
        <span className="text-[12px] text-neutral-text-secondary">
          · Sprint cadence or continuous Kanban flow
        </span>
      </div>
      <div className="px-4 py-4">
        {(() => {
          if (isLoading || !project)
            return (
              <div className="h-16 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse" />
            );
          if (isWaterfall)
            return (
              <p className="text-[12px] text-neutral-text-secondary">
                Waterfall projects don&rsquo;t use sprints — board cadence doesn&rsquo;t apply.
              </p>
            );
          if (!canEdit)
            return (
              <div className="space-y-3">
                <ReadOnlyIndicator
                  label="Board cadence"
                  value={CADENCE_OPTIONS.find((o) => o.id === selected)?.label ?? selected}
                  provenance="managed by the project scheduler"
                />
                <p className="text-[12px] text-neutral-text-secondary">
                  Continuous flow hides sprint tracking (planning, burndown, sprint header) and
                  leans on the flow-analytics panel. Tasks still move through your board columns.
                </p>
              </div>
            );
          return (
            <div className="space-y-3">
              <div
                role="radiogroup"
                aria-labelledby="cadence-heading"
                tabIndex={-1}
                onKeyDown={onRadioKeyDown}
                className="grid grid-cols-2 gap-3 outline-none"
              >
                {CADENCE_OPTIONS.map((opt, i) => {
                  const isSelected = selected === opt.id;
                  return (
                    <button
                      key={opt.id}
                      ref={(el) => {
                        btnRefs.current[i] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      // Roving tabindex: only the focused option is in the tab order.
                      tabIndex={i === focusIdx ? 0 : -1}
                      disabled={!canEdit || update.isPending}
                      onClick={() => {
                        if (canEdit && opt.id !== selected)
                          update.mutate({ board_cadence: opt.id });
                      }}
                      className={[
                        'text-left rounded-card border p-3 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                        !canEdit ? 'cursor-not-allowed' : '',
                        isSelected
                          ? 'border-2 border-brand-primary bg-brand-primary-light'
                          : 'border border-neutral-border bg-neutral-surface-raised hover:bg-neutral-surface-sunken',
                        !canEdit && !isSelected ? 'opacity-60' : '',
                      ].join(' ')}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[13px] font-semibold text-neutral-text-primary">
                          {opt.label}
                        </span>
                        {isSelected && (
                          <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 bg-sage-500 text-navy-900">
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M3 8l4 4 6-7"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-neutral-text-secondary leading-snug">
                        {opt.desc}
                      </p>
                    </button>
                  );
                })}
              </div>
              <p className="text-[12px] text-neutral-text-secondary">
                Continuous flow hides sprint tracking (planning, burndown, sprint header) and leans
                on the flow-analytics panel. Tasks still move through your board columns.
              </p>
              {selected === 'continuous' && activeSprint && (
                <p className="text-[12px] rounded-card border border-brand-accent/30 bg-brand-accent/10 text-neutral-text-primary px-3 py-2">
                  ⚠ This board has an active sprint. Continuous flow hides sprint tracking — the
                  sprint and its data are preserved and return if you switch back to sprint-based.
                </p>
              )}
              {update.isError && (
                <p className="text-[12px] text-semantic-critical">
                  {extractErrorDetail(update.error) ?? 'Could not update board cadence.'}
                </p>
              )}
            </div>
          );
        })()}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared row primitives (phase + status rows)
//
// Phase and status rows are the same interaction: a drag handle, a color swatch,
// an inline-rename cell, and a swatch picker, differing only in nouns and the
// swatch shape. Extracting them keeps both rows flat (issue #2356 cognitive-
// complexity pass) and guarantees the two rows can't visually drift apart.
// ---------------------------------------------------------------------------

type SortableHandleProps = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners'>;

function ReorderHandle({
  canEdit,
  ariaLabel,
  attributes,
  listeners,
}: { canEdit: boolean; ariaLabel: string } & SortableHandleProps) {
  if (canEdit) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        {...attributes}
        {...listeners}
        className="text-neutral-text-disabled select-none text-[16px] leading-none cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
      >
        ⠿
      </button>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="text-neutral-text-disabled select-none text-[16px] leading-none"
    >
      ⠿
    </span>
  );
}

function ColorSwatchToggle({
  canEdit,
  ariaLabel,
  color,
  shape,
  onClick,
}: {
  canEdit: boolean;
  ariaLabel: string;
  color: string | null;
  shape: 'rounded-control' | 'rounded-full';
  onClick: () => void;
}) {
  const background = color ?? '#94A3B8';
  if (canEdit) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className={`w-[18px] h-[18px] ${shape} border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary`}
        style={{ background }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`w-[18px] h-[18px] ${shape} border border-neutral-border/55`}
      style={{ background }}
    />
  );
}

function InlineRenameCell({
  canEdit,
  editing,
  draft,
  committed,
  renameAriaLabel,
  onDraftChange,
  onStartEdit,
  onSubmit,
  onCancel,
}: {
  canEdit: boolean;
  editing: boolean;
  draft: string;
  committed: string;
  renameAriaLabel: string;
  onDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  if (canEdit && editing) {
    return (
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- inline rename: focus follows user click into edit mode
        autoFocus
        aria-label={renameAriaLabel}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onSubmit}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') onSubmit();
          else if (e.key === 'Escape') onCancel();
        }}
        className="text-[13px] font-medium text-neutral-text-primary bg-neutral-surface-sunken border border-neutral-border rounded-control px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />
    );
  }
  if (canEdit) {
    return (
      <button
        type="button"
        onClick={onStartEdit}
        className="text-left text-[13px] font-medium text-neutral-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
      >
        {committed}
      </button>
    );
  }
  return <span className="text-[13px] font-medium text-neutral-text-primary">{committed}</span>;
}

function SwatchPicker({
  noun,
  shape,
  onPick,
  onClear,
}: {
  noun: 'phase' | 'status';
  shape: 'rounded-control' | 'rounded-full';
  onPick: (color: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-1.5 pl-[56px]">
      {COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Set ${noun} color to ${COLOR_SWATCH_NAMES[c]}`}
          onClick={() => onPick(c)}
          className={`w-5 h-5 ${shape} border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary`}
          style={{ background: c }}
        />
      ))}
      <button
        type="button"
        onClick={onClear}
        className="px-1.5 py-0.5 text-[11px] text-neutral-text-secondary border border-neutral-border/55 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Clear
      </button>
    </div>
  );
}

/** Inline-rename commit shared by phase + status rows: commit a non-empty change,
 *  otherwise revert the draft to the committed value; either way exit edit mode. */
function commitInlineRename(
  draft: string,
  committed: string,
  onRename: (value: string) => void,
  revertDraft: (value: string) => void,
  exitEdit: () => void,
): void {
  const trimmed = draft.trim();
  if (trimmed && trimmed !== committed) onRename(trimmed);
  else revertDraft(committed);
  exitEdit();
}

/** Draft text for a per-column age threshold (empty string = inherit the default). */
function ageDraftString(days: number | null): string {
  return days != null ? String(days) : '';
}

/**
 * Commit a per-column aging-threshold draft (issue 410): blank clears the override,
 * a valid positive integer sets it, anything else reverts the draft to the last
 * saved value rather than persisting garbage. No-ops when the value is unchanged.
 */
function commitAgeThreshold(
  draft: string,
  current: number | null,
  setThreshold: (days: number | null) => void,
  revertDraft: (text: string) => void,
): void {
  const trimmed = draft.trim();
  if (trimmed === '') {
    if (current !== null) setThreshold(null);
    return;
  }
  const next = Number(trimmed);
  if (!Number.isInteger(next) || next < 1) {
    revertDraft(ageDraftString(current));
    return;
  }
  if (next !== current) setThreshold(next);
}

/** Status-row aging-threshold cell: editable number input, or a read-out of the
 *  effective threshold (override → per-status default → off) when read-only. */
function AgeThresholdCell({
  canEdit,
  label,
  draft,
  defaultThreshold,
  current,
  onDraftChange,
  onCommit,
  onEscape,
}: {
  canEdit: boolean;
  label: string;
  draft: string;
  defaultThreshold: number | undefined;
  current: number | null;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onEscape: () => void;
}) {
  if (canEdit) {
    return (
      <input
        type="number"
        min={1}
        inputMode="numeric"
        aria-label={`Age limit in days for ${label}`}
        title="Cards in this column longer than this many days show an aging indicator. Leave blank to use the default."
        value={draft}
        placeholder={defaultThreshold != null ? String(defaultThreshold) : 'off'}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit();
          else if (e.key === 'Escape') onEscape();
        }}
        className="w-full text-[12px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 tppm-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />
    );
  }
  return (
    <span className="tppm-mono text-[11px] text-neutral-text-secondary">
      {current != null
        ? `${current}d`
        : defaultThreshold != null
          ? `${defaultThreshold}d`
          : 'off'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phases section
// ---------------------------------------------------------------------------

function PhasesSection({
  projectId,
  canEdit,
}: {
  projectId: string | undefined;
  canEdit: boolean;
}) {
  // No `create` (#2952): this page no longer manufactures phases. It configures
  // the ones the authoring gesture produced.
  const { phases, isLoading, update, remove, reorder } = useProjectPhases(projectId);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Local order overlay — applied immediately on drop, then persisted server-side
  // via /phases/reorder/. If the request fails, react-query invalidates and
  // reverts on the next refetch.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const orderedPhases = useMemo(() => {
    if (!pendingOrder) return phases;
    const byId = new Map(phases.map((p) => [p.id, p]));
    const out: ProjectPhase[] = [];
    for (const id of pendingOrder) {
      const p = byId.get(id);
      if (p) out.push(p);
    }
    return out;
  }, [phases, pendingOrder]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = orderedPhases.map((p) => p.id);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const next = [...ids];
    next.splice(oldIdx, 1);
    next.splice(newIdx, 0, String(active.id));
    setPendingOrder(next);
    reorder.mutate(next, {
      onSettled: () => setPendingOrder(null),
    });
  };

  return (
    <section
      aria-labelledby="phases-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
        <SettingsSubHeading id="phases-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Phases
        </SettingsSubHeading>
        <span className="text-[12px] text-neutral-text-secondary">
          · Swim-lanes on the board, summary rows on the schedule
        </span>
        <div className="flex-1" />
        {/* "+ Add phase" is deliberately GONE (#2952). It created a childless
            container literally named "New phase" — the exact defect the
            creation-coherence work exists to remove, and the reason the board
            used to render the same object as a lane and a card (ADR-0843).
            A phase now comes from the authoring gesture, where it arrives with
            work inside it. Nothing replaces the button; this page configures
            phases that exist rather than manufacturing empty ones. */}
      </div>

      {isLoading ? (
        <LoadingSkeleton label="Loading phases…" rows={3} className="px-4 py-6" />
      ) : orderedPhases.length === 0 ? (
        <div className="px-4 py-6 text-[12px] text-neutral-text-secondary">
          No phases yet. Phases group tasks into swim-lanes on the board and summary rows on
          the schedule — they are created on the{' '}
          <Link
            to={`/projects/${projectId}/schedule`}
            className="text-brand-primary underline underline-offset-2
              focus:outline-none focus:ring-2 focus:ring-brand-primary rounded-control"
          >
            schedule
          </Link>
          , by indenting a task under another, so a phase always arrives with work in it.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={orderedPhases.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="divide-y divide-neutral-border/55">
              {orderedPhases.map((phase, i) => (
                <PhaseRow
                  key={phase.id}
                  phase={phase}
                  index={i}
                  canEdit={canEdit}
                  onRename={(name) => update.mutate({ id: phase.id, payload: { name } })}
                  onRecolor={(color) => update.mutate({ id: phase.id, payload: { color } })}
                  onDelete={() => remove.mutate(phase.id)}
                  deleteError={
                    remove.error && remove.variables === phase.id
                      ? extractErrorDetail(remove.error)
                      : null
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function PhaseRow({
  phase,
  index,
  canEdit,
  onRename,
  onRecolor,
  onDelete,
  deleteError,
}: {
  phase: ProjectPhase;
  index: number;
  canEdit: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: string | null) => void;
  onDelete: () => void;
  deleteError: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: phase.id,
    disabled: !canEdit,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(phase.name);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const handleSubmit = () =>
    commitInlineRename(name, phase.name, onRename, setName, () => setEditing(false));

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={[
        'grid items-center gap-2.5 px-4 py-2.5 bg-neutral-surface-raised',
        isDragging ? 'opacity-70 z-10 shadow' : '',
      ].join(' ')}
    >
      <div
        className="grid items-center gap-2.5"
        style={{ gridTemplateColumns: '28px 28px 1fr 90px 90px 48px' }}
      >
        <ReorderHandle
          canEdit={canEdit}
          ariaLabel={`Reorder phase ${phase.name}`}
          attributes={attributes}
          listeners={listeners}
        />
        <ColorSwatchToggle
          canEdit={canEdit}
          ariaLabel={`Change color for ${phase.name}`}
          color={phase.color}
          shape="rounded-control"
          onClick={() => setShowColorPicker((v) => !v)}
        />
        <InlineRenameCell
          canEdit={canEdit}
          editing={editing}
          draft={name}
          committed={phase.name}
          renameAriaLabel={`Rename ${phase.name}`}
          onDraftChange={setName}
          onStartEdit={() => setEditing(true)}
          onSubmit={handleSubmit}
          onCancel={() => {
            setName(phase.name);
            setEditing(false);
          }}
        />
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">Phase {index + 1}</span>
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">
          {phase.taskCount} {phase.taskCount === 1 ? 'task' : 'tasks'}
        </span>
        {canEdit ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete phase ${phase.name}`}
            className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            ×
          </button>
        ) : (
          <span />
        )}
      </div>

      {showColorPicker && (
        <SwatchPicker
          noun="phase"
          shape="rounded-control"
          onPick={(c) => {
            onRecolor(c);
            setShowColorPicker(false);
          }}
          onClear={() => {
            onRecolor(null);
            setShowColorPicker(false);
          }}
        />
      )}

      {deleteError && (
        <p className="mt-1 pl-[56px] text-[11px] text-semantic-critical">{deleteError}</p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Statuses section
// ---------------------------------------------------------------------------

function StatusesSection({
  projectId,
  canEdit,
}: {
  projectId: string | undefined;
  canEdit: boolean;
}) {
  const { columns, isLoading, save } = useBoardConfig(projectId ?? null);
  const [pendingColumns, setPendingColumns] = useState<BoardColumnDef[] | null>(null);
  const effective = pendingColumns ?? columns;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const persist = (next: BoardColumnDef[]) => {
    setPendingColumns(next);
    void save(next).finally(() => setPendingColumns(null));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids: string[] = effective.map((c) => c.status);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const next = [...effective];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved);
    persist(next);
  };

  const updateColumn = (status: string, patch: Partial<BoardColumnDef>) => {
    const next = effective.map((c) => (c.status === status ? { ...c, ...patch } : c));
    persist(next);
  };

  return (
    <section
      aria-labelledby="statuses-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
        <SettingsSubHeading id="statuses-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Statuses
        </SettingsSubHeading>
        <FieldHelp
          label="Statuses"
          body="Each status is a column on the board and the status pill on task cards. The five canonical statuses are fixed — rename, recolor, reorder, or hide a column here. The per-column age limit flags cards that have sat in that column longer than the set number of days with an aging indicator; leave it blank to use the default. Hiding a column keeps its tasks but removes the column from the board."
          docHref="administration/project-settings/#workflow--fields"
        />
        <span className="text-[12px] text-neutral-text-secondary">
          · Columns on the board · Status pill on cards
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-neutral-text-disabled">
          The five canonical statuses are fixed; rename, recolor, or hide them here.
        </span>
      </div>

      {isLoading ? (
        <LoadingSkeleton label="Loading statuses…" rows={5} className="px-4 py-6" />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={effective.map((c) => c.status)}
            strategy={verticalListSortingStrategy}
          >
            <div
              aria-hidden="true"
              className="grid items-center gap-2.5 px-4 py-2 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-disabled"
              style={{ gridTemplateColumns: '28px 28px 1fr 84px 96px 104px' }}
            >
              <span />
              <span />
              <span>Column</span>
              <span>Status</span>
              <span>Age (days)</span>
              <span>Visibility</span>
            </div>
            <ul className="divide-y divide-neutral-border/55">
              {effective.map((col) => (
                <StatusRow
                  key={col.status}
                  column={col}
                  canEdit={canEdit}
                  onRename={(label) => updateColumn(col.status, { label })}
                  onRecolor={(color) => updateColumn(col.status, { color })}
                  onToggleVisible={() => updateColumn(col.status, { visible: !col.visible })}
                  onSetAgeThreshold={(days) => updateColumn(col.status, { ageThresholdDays: days })}
                  onSetLanes={(lanes) => updateColumn(col.status, { lanes })}
                  nextLaneKey={(label) => uniqueLaneKey(label, effective)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function StatusRow({
  column,
  canEdit,
  onRename,
  onRecolor,
  onToggleVisible,
  onSetAgeThreshold,
  onSetLanes,
  nextLaneKey,
}: {
  column: BoardColumnDef;
  canEdit: boolean;
  onRename: (label: string) => void;
  onRecolor: (color: string | null) => void;
  onToggleVisible: () => void;
  onSetAgeThreshold: (days: number | null) => void;
  onSetLanes: (lanes: BoardLaneDef[]) => void;
  /** Mint a key unique across the WHOLE config — the server's uniqueness scope. */
  nextLaneKey: (label: string) => string;
}) {
  const [showLanes, setShowLanes] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.status,
    disabled: !canEdit,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(column.label);
  const [showColorPicker, setShowColorPicker] = useState(false);
  // Per-column aging threshold override (issue 410). Empty input = inherit the per-status
  // default; committed on blur/Enter (one PUT per commit, mirroring the inline rename).
  const [ageDraft, setAgeDraft] = useState(ageDraftString(column.ageThresholdDays));
  const defaultThreshold = COLUMN_SLA_DEFAULTS[column.status];

  const commitAge = () =>
    commitAgeThreshold(ageDraft, column.ageThresholdDays, onSetAgeThreshold, setAgeDraft);
  const handleSubmit = () =>
    commitInlineRename(label, column.label, onRename, setLabel, () => setEditing(false));

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={[
        'px-4 py-2.5 bg-neutral-surface-raised',
        isDragging ? 'opacity-70 z-10 shadow' : '',
      ].join(' ')}
    >
      <div
        className="grid items-center gap-2.5"
        style={{ gridTemplateColumns: '28px 28px 1fr 84px 96px 104px' }}
      >
        <ReorderHandle
          canEdit={canEdit}
          ariaLabel={`Reorder status ${column.label}`}
          attributes={attributes}
          listeners={listeners}
        />
        <ColorSwatchToggle
          canEdit={canEdit}
          ariaLabel={`Change color for ${column.label}`}
          color={column.color}
          shape="rounded-full"
          onClick={() => setShowColorPicker((v) => !v)}
        />
        <InlineRenameCell
          canEdit={canEdit}
          editing={editing}
          draft={label}
          committed={column.label}
          renameAriaLabel={`Rename ${column.label}`}
          onDraftChange={setLabel}
          onStartEdit={() => setEditing(true)}
          onSubmit={handleSubmit}
          onCancel={() => {
            setLabel(column.label);
            setEditing(false);
          }}
        />
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">{column.status}</span>
        <AgeThresholdCell
          canEdit={canEdit}
          label={column.label}
          draft={ageDraft}
          defaultThreshold={defaultThreshold}
          current={column.ageThresholdDays}
          onDraftChange={setAgeDraft}
          onCommit={commitAge}
          onEscape={() => setAgeDraft(ageDraftString(column.ageThresholdDays))}
        />
        {canEdit ? (
          <button
            type="button"
            onClick={onToggleVisible}
            aria-pressed={column.visible}
            className="text-[11px] text-neutral-text-secondary border border-neutral-border/55 rounded-control px-2 py-0.5 hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {column.visible ? 'Hide column' : 'Show column'}
          </button>
        ) : (
          <span className="text-[11px] text-neutral-text-disabled">
            {column.visible ? 'Visible' : 'Hidden'}
          </span>
        )}
      </div>

      {showColorPicker && (
        <SwatchPicker
          noun="status"
          shape="rounded-full"
          onPick={(c) => {
            onRecolor(c);
            setShowColorPicker(false);
          }}
          onClear={() => {
            onRecolor(null);
            setShowColorPicker(false);
          }}
        />
      )}

      <LaneEditor
        column={column}
        canEdit={canEdit}
        expanded={showLanes}
        onToggleExpanded={() => setShowLanes((v) => !v)}
        onSetLanes={onSetLanes}
        nextLaneKey={nextLaneKey}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Named board lanes within one status column (#2967)
// ---------------------------------------------------------------------------

/**
 * Add / rename / remove the named lanes inside one status column.
 *
 * The whole point of the shape is what it does NOT touch: a lane is a second
 * axis over the five canonical statuses, so a team gets Review / QA / Blocked as
 * distinct board stages while `Task.status` stays canonical for burndown,
 * throughput rollup, MS Project export and every integration. That is why lanes
 * are edited *inside* a status row rather than as a sixth row — the row is the
 * status, and the status list is fixed.
 *
 * Deleting a lane never touches a card: anything left pointing at it resolves to
 * the column's first lane, on the client and in the server's counts alike.
 */
function LaneEditor({
  column,
  canEdit,
  expanded,
  onToggleExpanded,
  onSetLanes,
  nextLaneKey,
}: {
  column: BoardColumnDef;
  canEdit: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSetLanes: (lanes: BoardLaneDef[]) => void;
  nextLaneKey: (label: string) => string;
}) {
  const lanes = column.lanes ?? [];
  const atCap = lanes.length >= MAX_LANES_PER_COLUMN;

  const addLane = () => {
    const label = `Lane ${lanes.length + 1}`;
    onSetLanes([...lanes, { key: nextLaneKey(label), label, wipLimit: null }]);
  };
  const renameLane = (key: string, label: string) =>
    onSetLanes(lanes.map((l) => (l.key === key ? { ...l, label } : l)));
  const removeLane = (key: string) => onSetLanes(lanes.filter((l) => l.key !== key));

  return (
    <div className="mt-1.5 pl-[60px]">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        data-testid={`lanes-toggle-${column.status}`}
        // rule 214: a standalone aria-expanded trigger uses focus:, not
        // focus-visible: — Firefox/Safari/Chromium do not match :focus-visible on
        // a pointer-initiated button focus, so the ring would never show.
        className="text-[11px] text-neutral-text-secondary hover:text-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control px-1"
      >
        {expanded ? '▾' : '▸'} Lanes{lanes.length > 0 ? ` (${lanes.length})` : ''}
      </button>
      {expanded && (
        <div className="mt-1.5 border-l border-neutral-border/55 pl-3 py-1">
          <p className="text-[11px] text-neutral-text-disabled mb-1.5">
            Split {column.label} into named lanes on the board. Cards keep the {column.status}{' '}
            status, so reports and exports are unaffected.
          </p>
          <ul className="flex flex-col gap-1">
            {lanes.map((lane) => (
              <li key={lane.key} className="flex items-center gap-2">
                <input
                  type="text"
                  value={lane.label}
                  disabled={!canEdit}
                  maxLength={24}
                  aria-label={`Rename lane ${lane.label} in ${column.label}`}
                  onChange={(e) => renameLane(lane.key, e.target.value)}
                  className="text-[12px] w-40 border border-neutral-border/55 rounded-control px-1.5 py-0.5 bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-60"
                />
                <span className="tppm-mono text-[10px] text-neutral-text-disabled">{lane.key}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeLane(lane.key)}
                    aria-label={`Remove lane ${lane.label} from ${column.label}`}
                    className="text-[11px] text-neutral-text-secondary hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control px-1"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <button
              type="button"
              onClick={addLane}
              disabled={atCap}
              data-testid={`add-lane-${column.status}`}
              className="mt-1.5 text-[11px] text-brand-primary disabled:text-neutral-text-disabled hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control px-1"
            >
              {atCap ? `Limit is ${MAX_LANES_PER_COLUMN} lanes` : '+ Add lane'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fields section (built-in catalog + custom fields)
// ---------------------------------------------------------------------------

function FieldsSection({
  projectId,
  canEdit,
}: {
  projectId: string | undefined;
  canEdit: boolean;
}) {
  const { fields, isLoading, create, update, remove } = useProjectCustomFields(projectId);
  const [showAdd, setShowAdd] = useState(false);
  const [editingField, setEditingField] = useState<ProjectCustomField | null>(null);

  const customFieldTypeLabel = (t: CustomFieldType): string =>
    CUSTOM_FIELD_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;

  return (
    <section
      aria-labelledby="fields-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
        <SettingsSubHeading id="fields-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Fields
        </SettingsSubHeading>
        <span className="text-[12px] text-neutral-text-secondary">
          · Built-ins are required by the scheduler. Custom fields appear in the task drawer.
        </span>
        <div className="flex-1" />
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="px-2.5 py-1 rounded-control border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            + New field
          </button>
        )}
      </div>

      {/* Table header */}
      <div
        className="grid px-4 py-2 bg-neutral-surface-sunken border-b border-neutral-border/55 text-xs font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
        style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 96px 48px' }}
      >
        <span>Field</span>
        <span className="inline-flex items-center gap-1 normal-case tracking-normal">
          Type
          <FieldHelp
            label="Field type"
            intro="The kind of value this field holds. Type is fixed once the field is created."
            options={CUSTOM_FIELD_TYPE_HELP}
            docHref="administration/project-settings/#workflow--fields"
          />
        </span>
        <span className="inline-flex items-center gap-1 normal-case tracking-normal">
          Required
          <FieldHelp
            label="Required"
            body="A required field must have a value on every task before the task can be saved. Built-in fields marked Required are enforced by the scheduler and can't be turned off; custom fields are optional unless you mark them required."
            docHref="administration/project-settings/#workflow--fields"
          />
        </span>
        <span>Source</span>
        <span className="inline-flex items-center gap-1 normal-case tracking-normal">
          On card
          <FieldHelp
            label="Show on card"
            body="Adds this field's value to task cards on the board. Off by default to keep cards scannable — custom fields render after all built-in card content and are the first to collapse into overflow."
            docHref="features/board/#custom-fields-on-cards"
          />
        </span>
        <span />
      </div>

      {/* Built-in catalog — read-only */}
      <ul className="divide-y divide-neutral-border/55">
        {BUILT_IN_FIELDS.map((f) => (
          <li
            key={f.id}
            className="grid items-center gap-2.5 px-4 py-2.5 text-[13px]"
            style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 96px 48px' }}
          >
            <span className="font-medium text-neutral-text-primary">{f.name}</span>
            <span className="text-[12px] text-neutral-text-secondary">{f.typeLabel}</span>
            <span>
              {f.required ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-brand-primary-light text-brand-primary">
                  Required
                </span>
              ) : (
                <span className="text-neutral-text-disabled text-[11px]">—</span>
              )}
            </span>
            <span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border/55">
                Built-in
              </span>
            </span>
            {/* Built-in fields already have first-class card treatment — not opt-in here. */}
            <span className="text-neutral-text-disabled text-[11px]">—</span>
            <span />
          </li>
        ))}

        {isLoading ? (
          <li className="px-4 py-4 text-[12px] text-neutral-text-secondary">
            Loading custom fields…
          </li>
        ) : (
          fields.map((f) => (
            <li
              key={f.id}
              className="grid items-center gap-2.5 px-4 py-2.5 text-[13px]"
              style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 96px 48px' }}
            >
              <span className="font-medium text-neutral-text-primary">{f.name}</span>
              <span className="text-[12px] text-neutral-text-secondary">
                {customFieldTypeLabel(f.fieldType)}
              </span>
              <span>
                {f.required ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-brand-primary-light text-brand-primary">
                    Required
                  </span>
                ) : (
                  <span className="text-neutral-text-disabled text-[11px]">—</span>
                )}
              </span>
              <span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-brand-accent-light dark:bg-brand-accent/20 text-brand-accent-text dark:text-brand-accent">
                  Custom
                </span>
              </span>
              {/* Show-on-card opt-in (#2144) — Scheduler+ writes the field definition. */}
              <span>
                {canEdit ? (
                  <Toggle
                    on={f.showOnCard}
                    onChange={(next) => update.mutate({ id: f.id, payload: { showOnCard: next } })}
                    onLabel=""
                    offLabel=""
                    ariaLabel={`Show ${f.name} on board cards`}
                  />
                ) : f.showOnCard ? (
                  <span className="text-[11px] text-neutral-text-secondary">On card</span>
                ) : (
                  <span className="text-neutral-text-disabled text-[11px]">—</span>
                )}
              </span>
              {canEdit ? (
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingField(f)}
                    aria-label={`Edit ${f.name}`}
                    className="text-[11px] text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control px-1"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(f.id)}
                    aria-label={`Delete ${f.name}`}
                    className="text-[18px] leading-none text-neutral-text-secondary hover:text-semantic-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <span />
              )}
            </li>
          ))
        )}
      </ul>

      {showAdd && (
        <CustomFieldModal
          mode="create"
          submitting={create.isPending}
          error={extractErrorDetail(create.error)}
          onCancel={() => setShowAdd(false)}
          onSubmit={(payload) =>
            create.mutate(payload, {
              onSuccess: () => setShowAdd(false),
            })
          }
        />
      )}

      {editingField && (
        <CustomFieldModal
          mode="edit"
          initial={editingField}
          submitting={update.isPending}
          error={extractErrorDetail(update.error)}
          onCancel={() => setEditingField(null)}
          onSubmit={(payload) =>
            update.mutate(
              {
                id: editingField.id,
                payload: {
                  name: payload.name,
                  required: payload.required,
                  options: payload.options,
                  showOnCard: payload.showOnCard,
                },
              },
              {
                onSuccess: () => setEditingField(null),
              },
            )
          }
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Custom field create/edit modal
// ---------------------------------------------------------------------------

interface CustomFieldFormPayload {
  name: string;
  fieldType: CustomFieldType;
  required: boolean;
  options: CustomFieldOption[];
  showOnCard: boolean;
}

function CustomFieldModal({
  mode,
  initial,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: ProjectCustomField;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: CustomFieldFormPayload) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [fieldType, setFieldType] = useState<CustomFieldType>(initial?.fieldType ?? 'TEXT');
  const [required, setRequired] = useState(initial?.required ?? false);
  const [options, setOptions] = useState<CustomFieldOption[]>(initial?.options ?? []);
  const [showOnCard, setShowOnCard] = useState(initial?.showOnCard ?? false);

  // Trap focus and route Escape to Cancel; the hook restores focus to the trigger
  // on close. Initial focus stays on the name input (its autoFocus resolves first
  // and the trap skips re-seating while focus is already inside the container).
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  const canSubmit = name.trim().length > 0 && (!isSelectType(fieldType) || options.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      fieldType,
      required,
      options: isSelectType(fieldType) ? options : [],
      showOnCard,
    });
  };

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-field-modal-heading"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay focus:outline-none"
    >
      <form
        onSubmit={submit}
        className="bg-neutral-surface-raised rounded-card border border-neutral-border w-[480px] max-w-[92vw]"
      >
        <div className="px-4 py-3 border-b border-neutral-border">
          <h3
            id="custom-field-modal-heading"
            className="text-[13px] font-semibold text-neutral-text-primary"
          >
            {mode === 'create' ? 'New custom field' : `Edit field — ${initial?.name ?? ''}`}
          </h3>
        </div>
        <div className="px-4 py-4 space-y-3">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-text-secondary mb-1">
              Name
            </span>
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- modal: focus the first input on open per dialog UX convention
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
              className="w-full text-[13px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-text-secondary mb-1">
              Type
            </span>
            <select
              value={fieldType}
              onChange={(e) => {
                const next = e.target.value as CustomFieldType;
                setFieldType(next);
                if (!isSelectType(next)) setOptions([]);
              }}
              disabled={mode === 'edit'}
              className="w-full text-[13px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              {CUSTOM_FIELD_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {mode === 'edit' && (
              <p className="text-[11px] text-neutral-text-disabled mt-1">
                Type cannot change after creation — delete this field and add a new one to switch
                type.
              </p>
            )}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              className="rounded-control border-neutral-border"
            />
            <span className="text-[13px] text-neutral-text-primary">Required on every task</span>
          </label>
          {/* Show-on-card opt-in (#2144) — off by default to keep cards scannable. */}
          <div className="flex items-start justify-between gap-3 rounded-control border border-neutral-border bg-neutral-surface-raised px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  Show on card
                </span>
                <FieldHelp
                  label="Show on card"
                  body="Adds this field's value to task cards on the board. Custom fields render after all built-in card content and are the first to collapse into overflow — they never displace the health badge or story points."
                  docHref="features/board/#custom-fields-on-cards"
                />
              </div>
              <p className="mt-0.5 text-[12px] text-neutral-text-secondary">
                Off by default. Board residents can still mute all custom fields from the board’s
                display settings.
              </p>
            </div>
            <Toggle
              on={showOnCard}
              onChange={setShowOnCard}
              onLabel=""
              offLabel=""
              ariaLabel="Show on card"
            />
          </div>

          {isSelectType(fieldType) && <OptionsEditor options={options} onChange={setOptions} />}
        </div>

        {error && <p className="px-4 pb-2 text-[12px] text-semantic-critical">{error}</p>}

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-border">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-[12px] text-neutral-text-secondary border border-neutral-border rounded-control hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="px-3 py-1 text-[12px] font-medium text-neutral-text-inverse bg-brand-primary rounded-control hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {submitting ? 'Saving…' : mode === 'create' ? 'Add field' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: CustomFieldOption[];
  onChange: (next: CustomFieldOption[]) => void;
}) {
  const update = (idx: number, patch: Partial<CustomFieldOption>) => {
    onChange(options.map((o, i) => (i === idx ? { ...o, ...patch } : o)));
  };
  const remove = (idx: number) => onChange(options.filter((_, i) => i !== idx));
  const add = () => onChange([...options, { value: `option-${options.length + 1}`, label: '' }]);

  return (
    <div className="space-y-2">
      <span className="block text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-text-secondary">
        Options
      </span>
      {options.length === 0 && (
        <p className="text-[11px] text-neutral-text-disabled">No options yet. Add at least one.</p>
      )}
      <ul className="space-y-1.5">
        {options.map((opt, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              aria-label={`Option ${i + 1} value`}
              value={opt.value}
              onChange={(e) => update(i, { value: e.target.value })}
              className="flex-1 text-[12px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 tppm-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              placeholder="value"
              maxLength={32}
            />
            <input
              aria-label={`Option ${i + 1} label`}
              value={opt.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 text-[12px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              placeholder="Label"
              maxLength={64}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove option ${opt.value}`}
              className="text-neutral-text-secondary hover:text-semantic-critical text-[16px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="text-[12px] text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
      >
        + Add option
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error extraction (DRF returns either {detail: "..."} or per-field maps)
// ---------------------------------------------------------------------------

/** First per-field DRF validation error in a `{field: "msg" | ["msg", …]}` map. */
function firstFieldError(obj: Record<string, unknown>): string | null {
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return value[0];
    }
  }
  return null;
}

function extractErrorDetail(err: unknown): string | null {
  if (!err) return null;
  type AxiosLike = { response?: { data?: unknown } };
  const data = (err as AxiosLike).response?.data;
  if (!data) return err instanceof Error ? err.message : null;
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.detail === 'string') return obj.detail;
  return firstFieldError(obj);
}
