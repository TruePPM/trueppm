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
import { SettingsPageTitle } from '../SettingsShell';
import { BUILT_IN_FIELDS } from './builtInFields';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useActiveSprint } from '@/hooks/useSprints';
import { useBoardConfig, COLUMN_SLA_DEFAULTS, type BoardColumnDef } from '@/hooks/useBoardConfig';
import { useProjectPhases, type ProjectPhase } from '@/hooks/useProjectPhases';
import type { BoardCadence } from '@/types';
import {
  useProjectCustomFields,
  type CustomFieldOption,
  type CustomFieldType,
  type ProjectCustomField,
} from '@/hooks/useProjectCustomFields';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';

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

/** Project > Workflow & fields settings page (#521). */
export function ProjectWorkflowPage() {
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId);
  const canEditPhases = role !== null && role >= ROLE_ADMIN;
  const canEditStatusesOrFields = role !== null && role >= ROLE_SCHEDULER;

  return (
    <div>
      <SettingsPageTitle
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
    let next = focusIdx;
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
        <h2 id="cadence-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Board cadence
        </h2>
        <span className="text-[12px] text-neutral-text-secondary">
          · Sprint cadence or continuous Kanban flow
        </span>
      </div>
      <div className="px-4 py-4">
        {isLoading || !project ? (
          <div className="h-16 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse" />
        ) : isWaterfall ? (
          <p className="text-[12px] text-neutral-text-secondary">
            Waterfall projects don&rsquo;t use sprints — board cadence doesn&rsquo;t apply.
          </p>
        ) : (
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
                      if (canEdit && opt.id !== selected) update.mutate({ board_cadence: opt.id });
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
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
                    <p className="text-[12px] text-neutral-text-secondary leading-snug">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[12px] text-neutral-text-secondary">
              Continuous flow hides sprint tracking (planning, burndown, sprint header) and leans on
              the flow-analytics panel. Tasks still move through your board columns.
            </p>
            {selected === 'continuous' && activeSprint && (
              <p className="text-[12px] rounded-card border border-brand-accent/30 bg-brand-accent/10 text-neutral-text-primary px-3 py-2">
                ⚠ This board has an active sprint. Continuous flow hides sprint tracking — the sprint
                and its data are preserved and return if you switch back to sprint-based.
              </p>
            )}
            {update.isError && (
              <p className="text-[12px] text-semantic-critical">
                {extractErrorDetail(update.error) ?? 'Could not update board cadence.'}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
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
  const { phases, isLoading, create, update, remove, reorder } = useProjectPhases(projectId);
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

  const handleAddPhase = () => {
    create.mutate({ name: 'New phase' });
  };

  return (
    <section
      aria-labelledby="phases-heading"
      className="bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-neutral-border flex items-center gap-2">
        <h2 id="phases-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Phases
        </h2>
        <span className="text-[12px] text-neutral-text-secondary">
          · Swim-lanes on the board, summary rows on the schedule
        </span>
        <div className="flex-1" />
        {canEdit && (
          <button
            type="button"
            onClick={handleAddPhase}
            disabled={create.isPending}
            className="px-2.5 py-1 rounded-control border border-neutral-border text-[12px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
          >
            + Add phase
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-[12px] text-neutral-text-secondary">Loading…</div>
      ) : orderedPhases.length === 0 ? (
        <div className="px-4 py-6 text-[12px] text-neutral-text-secondary">
          No phases yet. Phases group tasks into swim-lanes on the board and summary rows on the
          schedule.
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

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== phase.name) onRename(trimmed);
    else setName(phase.name);
    setEditing(false);
  };

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
        {canEdit ? (
          <button
            type="button"
            aria-label={`Reorder phase ${phase.name}`}
            {...attributes}
            {...listeners}
            className="text-neutral-text-disabled select-none text-[16px] leading-none cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            ⠿
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="text-neutral-text-disabled select-none text-[16px] leading-none"
          >
            ⠿
          </span>
        )}
        {canEdit ? (
          <button
            type="button"
            aria-label={`Change color for ${phase.name}`}
            onClick={() => setShowColorPicker((v) => !v)}
            className="w-[18px] h-[18px] rounded-control border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            style={{ background: phase.color ?? '#94A3B8' }}
          />
        ) : (
          <span
            aria-hidden="true"
            className="w-[18px] h-[18px] rounded-control border border-neutral-border/55"
            style={{ background: phase.color ?? '#94A3B8' }}
          />
        )}
        {canEdit && editing ? (
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- inline rename: focus follows user click into edit mode
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleSubmit}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') handleSubmit();
              else if (e.key === 'Escape') {
                setName(phase.name);
                setEditing(false);
              }
            }}
            className="text-[13px] font-medium text-neutral-text-primary bg-neutral-surface-sunken border border-neutral-border rounded-control px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left text-[13px] font-medium text-neutral-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            {phase.name}
          </button>
        ) : (
          <span className="text-[13px] font-medium text-neutral-text-primary">{phase.name}</span>
        )}
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
        <div className="mt-2 flex items-center gap-1.5 pl-[56px]">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Set phase color to ${COLOR_SWATCH_NAMES[c]}`}
              onClick={() => {
                onRecolor(c);
                setShowColorPicker(false);
              }}
              className="w-5 h-5 rounded-control border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              style={{ background: c }}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              onRecolor(null);
              setShowColorPicker(false);
            }}
            className="px-1.5 py-0.5 text-[11px] text-neutral-text-secondary border border-neutral-border/55 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Clear
          </button>
        </div>
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
        <h2 id="statuses-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Statuses
        </h2>
        <span className="text-[12px] text-neutral-text-secondary">
          · Columns on the board · Status pill on cards
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-neutral-text-disabled">
          The five canonical statuses are fixed; rename, recolor, or hide them here.
        </span>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-[12px] text-neutral-text-secondary">Loading…</div>
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
                  onSetAgeThreshold={(days) =>
                    updateColumn(col.status, { ageThresholdDays: days })
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

function StatusRow({
  column,
  canEdit,
  onRename,
  onRecolor,
  onToggleVisible,
  onSetAgeThreshold,
}: {
  column: BoardColumnDef;
  canEdit: boolean;
  onRename: (label: string) => void;
  onRecolor: (color: string | null) => void;
  onToggleVisible: () => void;
  onSetAgeThreshold: (days: number | null) => void;
}) {
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
  const [ageDraft, setAgeDraft] = useState(
    column.ageThresholdDays != null ? String(column.ageThresholdDays) : '',
  );
  const defaultThreshold = COLUMN_SLA_DEFAULTS[column.status];

  const commitAge = () => {
    const trimmed = ageDraft.trim();
    if (trimmed === '') {
      if (column.ageThresholdDays !== null) onSetAgeThreshold(null);
      return;
    }
    const next = Number(trimmed);
    if (!Number.isInteger(next) || next < 1) {
      // Revert an invalid entry to the last saved value rather than persist garbage.
      setAgeDraft(column.ageThresholdDays != null ? String(column.ageThresholdDays) : '');
      return;
    }
    if (next !== column.ageThresholdDays) onSetAgeThreshold(next);
  };

  const handleSubmit = () => {
    const trimmed = label.trim();
    if (trimmed && trimmed !== column.label) onRename(trimmed);
    else setLabel(column.label);
    setEditing(false);
  };

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
        {canEdit ? (
          <button
            type="button"
            aria-label={`Reorder status ${column.label}`}
            {...attributes}
            {...listeners}
            className="text-neutral-text-disabled select-none text-[16px] leading-none cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            ⠿
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="text-neutral-text-disabled select-none text-[16px] leading-none"
          >
            ⠿
          </span>
        )}
        {canEdit ? (
          <button
            type="button"
            aria-label={`Change color for ${column.label}`}
            onClick={() => setShowColorPicker((v) => !v)}
            className="w-[18px] h-[18px] rounded-full border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            style={{ background: column.color ?? '#94A3B8' }}
          />
        ) : (
          <span
            aria-hidden="true"
            className="w-[18px] h-[18px] rounded-full border border-neutral-border/55"
            style={{ background: column.color ?? '#94A3B8' }}
          />
        )}
        {canEdit && editing ? (
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- inline rename: focus follows user click into edit mode
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={handleSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
              else if (e.key === 'Escape') {
                setLabel(column.label);
                setEditing(false);
              }
            }}
            className="text-[13px] font-medium text-neutral-text-primary bg-neutral-surface-sunken border border-neutral-border rounded-control px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left text-[13px] font-medium text-neutral-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-control"
          >
            {column.label}
          </button>
        ) : (
          <span className="text-[13px] font-medium text-neutral-text-primary">{column.label}</span>
        )}
        <span className="tppm-mono text-[11px] text-neutral-text-secondary">{column.status}</span>
        {canEdit ? (
          <input
            type="number"
            min={1}
            inputMode="numeric"
            aria-label={`Age limit in days for ${column.label}`}
            title="Cards in this column longer than this many days show an aging indicator. Leave blank to use the default."
            value={ageDraft}
            placeholder={defaultThreshold != null ? String(defaultThreshold) : 'off'}
            onChange={(e) => setAgeDraft(e.target.value)}
            onBlur={commitAge}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAge();
              else if (e.key === 'Escape') {
                setAgeDraft(column.ageThresholdDays != null ? String(column.ageThresholdDays) : '');
              }
            }}
            className="w-full text-[12px] bg-neutral-surface-sunken border border-neutral-border rounded-control px-2 py-1 tppm-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        ) : (
          <span className="tppm-mono text-[11px] text-neutral-text-secondary">
            {column.ageThresholdDays != null
              ? `${column.ageThresholdDays}d`
              : defaultThreshold != null
                ? `${defaultThreshold}d`
                : 'off'}
          </span>
        )}
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
        <div className="mt-2 flex items-center gap-1.5 pl-[56px]">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Set status color to ${COLOR_SWATCH_NAMES[c]}`}
              onClick={() => {
                onRecolor(c);
                setShowColorPicker(false);
              }}
              className="w-5 h-5 rounded-full border border-neutral-border/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              style={{ background: c }}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              onRecolor(null);
              setShowColorPicker(false);
            }}
            className="px-1.5 py-0.5 text-[11px] text-neutral-text-secondary border border-neutral-border/55 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Clear
          </button>
        </div>
      )}
    </li>
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
        <h2 id="fields-heading" className="text-[13px] font-semibold text-neutral-text-primary">
          Fields
        </h2>
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
        style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 48px' }}
      >
        <span>Field</span>
        <span>Type</span>
        <span>Required</span>
        <span>Source</span>
        <span />
      </div>

      {/* Built-in catalog — read-only */}
      <ul className="divide-y divide-neutral-border/55">
        {BUILT_IN_FIELDS.map((f) => (
          <li
            key={f.id}
            className="grid items-center gap-2.5 px-4 py-2.5 text-[13px]"
            style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 48px' }}
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
              style={{ gridTemplateColumns: '1.2fr 1fr 100px 100px 48px' }}
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
                <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-brand-accent-light text-brand-accent-dark">
                  Custom
                </span>
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

  const canSubmit = name.trim().length > 0 && (!isSelectType(fieldType) || options.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      fieldType,
      required,
      options: isSelectType(fieldType) ? options : [],
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-field-modal-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
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
            className="px-3 py-1 text-[12px] font-medium text-white bg-brand-primary rounded-control hover:bg-brand-primary-dark disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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

function extractErrorDetail(err: unknown): string | null {
  if (!err) return null;
  type AxiosLike = { response?: { data?: unknown } };
  const data = (err as AxiosLike).response?.data;
  if (!data) {
    return err instanceof Error ? err.message : null;
  }
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    // Pick the first per-field error.
    for (const value of Object.values(obj)) {
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
        return value[0];
      }
    }
  }
  return null;
}
