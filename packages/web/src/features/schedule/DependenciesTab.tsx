import { useState, useEffect } from 'react';
import type { Task, TaskLink, LinkType } from '@/types';
import {
  useCreateDependency,
  useUpdateDependency,
  useDeleteDependency,
} from '@/hooks/useDependencyMutations';
import { parseCyclicDependencyError, formatCycleMessage } from '@/hooks/useTaskMutations';
import { ScheduleDependencyPicker } from './ScheduleDependencyPicker';
import {
  LINK_TYPE_OPTIONS,
  linkTypeFieldLabel,
  lagFieldLabelFor,
  LAG_MIN_DAYS,
  LAG_MAX_DAYS,
  LAG_FIELD_HINT,
  LAG_UNIT_SUFFIX,
  clampLagDays,
  LINK_TYPE_PROSE_NAME,
} from './deps/linkTypes';

/** The drawer's `<select>` options. Sourced from `deps/linkTypes` so the drawer
 *  and the picker offer the same four in the same order with the same words. */
const DEP_TYPES = LINK_TYPE_OPTIONS;

interface DependenciesTabProps {
  task: Task;
  tasks: Task[];
  links: TaskLink[];
  projectId: string;
  /** Program this project belongs to, or null for a standalone project (ADR-0120). */
  programId?: string | null;
  /**
   * May this reader author dependency edges? (#3143)
   *
   * Required, not optional-with-a-default: this component had no gate at all,
   * so every write control — including the only **delete** among the five
   * dependency surfaces — rendered for a Viewer. A default would let the next
   * call site reintroduce that silently, which is exactly how it got here.
   *
   * Resolve it with `canAuthorDependencies`, never `canEdit`/`canEditTask`.
   * Edges are `IsProjectScheduler` and task content is `IsProjectPlanAuthor`;
   * neither band contains the other (ADR-0773 §7), so borrowing the task-content
   * verdict strands a Scheduler on the one route that is their keyboard path to
   * the capability (`Alt+Enter` → Dependencies) while offering a Member a 403.
   *
   * When false the controls are **absent**, not disabled: a disabled control
   * still advertises a capability the reader does not have, and the edges
   * themselves stay readable as text.
   */
  canWrite: boolean;
}

export function DependenciesTab({
  task,
  tasks,
  links,
  projectId,
  programId,
  canWrite,
}: DependenciesTabProps) {
  const createDep = useCreateDependency(projectId);
  const updateDep = useUpdateDependency(projectId);
  const deleteDep = useDeleteDependency(projectId);

  const [addPredId, setAddPredId] = useState('');
  const [addPredType, setAddPredType] = useState<LinkType>('FS');
  const [addSuccId, setAddSuccId] = useState('');
  const [addSuccType, setAddSuccType] = useState<LinkType>('FS');
  const [addPredLag, setAddPredLag] = useState('0');
  const [addSuccLag, setAddSuccLag] = useState('0');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Which side opened the cross-project picker (ADR-0120) — the inline
  // dropdowns below only ever list this project's tasks, so a task in a
  // sibling project is reachable only through this modal.
  const [crossPickerMode, setCrossPickerMode] = useState<'predecessor' | 'successor' | null>(null);

  useEffect(() => {
    setAddPredId('');
    setAddPredType('FS');
    setAddSuccId('');
    setAddSuccType('FS');
    setErrorMessage(null);
    setCrossPickerMode(null);
  }, [task.id]);

  const predecessorLinks = links.filter((l) => l.targetId === task.id);
  const successorLinks = links.filter((l) => l.sourceId === task.id);
  const linkedPredIds = new Set(predecessorLinks.map((l) => l.sourceId));
  const linkedSuccIds = new Set(successorLinks.map((l) => l.targetId));
  const availableAsPred = tasks.filter((t) => t.id !== task.id && !linkedPredIds.has(t.id));
  const availableAsSucc = tasks.filter((t) => t.id !== task.id && !linkedSuccIds.has(t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const taskId = task.id;

  function handleAddPred() {
    if (!addPredId) return;
    setErrorMessage(null);
    createDep.mutate(
      { predecessor: addPredId, successor: taskId, dep_type: addPredType, lag: clampLagDays(addPredLag) },
      {
        onSuccess: () => {
          setAddPredId('');
          setAddPredType('FS');
          setAddPredLag('0');
        },
        // Cycle errors keep the predecessor selection intact so the user can
        // adjust without re-picking from the dropdown (#356 AC).
        onError: (err) => {
          const cycle = parseCyclicDependencyError(err);
          setErrorMessage(
            cycle ? formatCycleMessage(cycle) : 'Couldn’t add dependency. Try again.',
          );
        },
      },
    );
  }

  function handleAddSucc() {
    if (!addSuccId) return;
    setErrorMessage(null);
    createDep.mutate(
      { predecessor: taskId, successor: addSuccId, dep_type: addSuccType, lag: clampLagDays(addSuccLag) },
      {
        onSuccess: () => {
          setAddSuccId('');
          setAddSuccType('FS');
          setAddSuccLag('0');
        },
        onError: (err) => {
          const cycle = parseCyclicDependencyError(err);
          setErrorMessage(
            cycle ? formatCycleMessage(cycle) : 'Couldn’t add dependency. Try again.',
          );
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Predecessors">
        <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
          Predecessors
        </h3>
        {predecessorLinks.length === 0 && (
          <p className="text-xs text-neutral-text-disabled mb-2">None</p>
        )}
        {predecessorLinks.map((link) => {
          const srcTask = taskById.get(link.sourceId);
          if (!srcTask) return null;
          return (
            <DepRow
              key={link.id}
              link={link}
              relatedTask={srcTask}
              onUpdate={(patch, opts) => updateDep.mutate({ id: link.id, ...patch }, opts)}
              onDelete={() => deleteDep.mutate(link.id)}
              canWrite={canWrite}
            />
          );
        })}
        {canWrite && (
          <AddDepRow
            availableTasks={availableAsPred}
            selectedTaskId={addPredId}
            selectedType={addPredType}
            isPending={createDep.isPending}
            onTaskChange={setAddPredId}
            onTypeChange={setAddPredType}
            lagText={addPredLag}
            onLagChange={setAddPredLag}
            onAdd={handleAddPred}
            addLabel="Add predecessor"
            relation="predecessor"
          />
        )}
        {canWrite && programId && (
          <CrossProjectSearchLink onClick={() => setCrossPickerMode('predecessor')} />
        )}
      </section>

      <section aria-label="Successors">
        <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
          Successors
        </h3>
        {successorLinks.length === 0 && (
          <p className="text-xs text-neutral-text-disabled mb-2">None</p>
        )}
        {successorLinks.map((link) => {
          const tgtTask = taskById.get(link.targetId);
          if (!tgtTask) return null;
          return (
            <DepRow
              key={link.id}
              link={link}
              relatedTask={tgtTask}
              onUpdate={(patch, opts) => updateDep.mutate({ id: link.id, ...patch }, opts)}
              onDelete={() => deleteDep.mutate(link.id)}
              canWrite={canWrite}
            />
          );
        })}
        {canWrite && (
          <AddDepRow
            availableTasks={availableAsSucc}
            selectedTaskId={addSuccId}
            selectedType={addSuccType}
            isPending={createDep.isPending}
            onTaskChange={setAddSuccId}
            onTypeChange={setAddSuccType}
            lagText={addSuccLag}
            onLagChange={setAddSuccLag}
            onAdd={handleAddSucc}
            addLabel="Add successor"
            relation="successor"
          />
        )}
        {canWrite && programId && (
          <CrossProjectSearchLink onClick={() => setCrossPickerMode('successor')} />
        )}
      </section>

      {crossPickerMode && (
        <ScheduleDependencyPicker
          task={task}
          initialDirection={crossPickerMode}
          projectId={projectId}
          programId={programId}
          allTasks={tasks}
          excludedIds={{ predecessor: linkedPredIds, successor: linkedSuccIds }}
          initialScope="program"
          onClose={() => setCrossPickerMode(null)}
        />
      )}

      {errorMessage && (
        <div
          role="alert"
          className="bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical text-xs px-3 py-2 rounded-card"
        >
          {errorMessage}
        </div>
      )}

      <p className="text-xs text-neutral-text-disabled border-t border-neutral-border pt-4">
        Successors are automatically rescheduled by the CPM engine after dependency changes.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DepRow
// ---------------------------------------------------------------------------

interface DepRowProps {
  link: TaskLink;
  relatedTask: Task;
  onUpdate: (
    patch: { dep_type?: LinkType; lag?: number },
    opts?: { onError?: (err: unknown) => void },
  ) => void;
  onDelete: () => void;
  /** See `DependenciesTabProps.canWrite`. False renders the row as text. */
  canWrite: boolean;
}

function DepRow({ link, relatedTask, onUpdate, onDelete, canWrite }: DepRowProps) {
  const [rowError, setRowError] = useState<string | null>(null);
  const label = relatedTask.wbs ? `${relatedTask.wbs} — ${relatedTask.name}` : relatedTask.name;

  return (
    <div className="border-b border-neutral-border/40 last:border-b-0">
      <div className="flex items-center gap-2 py-1.5">
        <span className="flex-1 text-sm text-neutral-text-primary truncate" title={label}>
          {label}
        </span>
        {!canWrite ? (
          /* Read-only: the edge stays legible, but type, lag and delete are
             absent rather than disabled (#3143). `link.lag` is suppressed at 0
             so the common case reads as a bare relation type. */
          <span className="text-xs text-neutral-text-secondary shrink-0">
            {LINK_TYPE_PROSE_NAME[link.type] ?? link.type}
            {link.lag !== 0 && ` · ${link.lag}${LAG_UNIT_SUFFIX}`}
          </span>
        ) : (
          <>
            <select
              value={link.type}
              onChange={(e) => {
                setRowError(null);
                onUpdate(
                  { dep_type: e.target.value as LinkType },
                  {
                    onError: (err) => {
                      const cycle = parseCyclicDependencyError(err);
                      setRowError(
                        cycle
                          ? formatCycleMessage(cycle)
                          : 'Couldn’t update dependency. Try again.',
                      );
                    },
                  },
                );
              }}
              aria-label={linkTypeFieldLabel(label)}
              className="text-xs border border-neutral-border rounded-control px-1.5 py-1
              bg-neutral-surface text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {DEP_TYPES.map((dt) => (
                <option key={dt.value} value={dt.value}>
                  {dt.label}
                </option>
              ))}
            </select>
            <input
              key={`${link.id}-lag-${link.lag}`}
              type="number"
              defaultValue={link.lag}
              min={LAG_MIN_DAYS}
              max={LAG_MAX_DAYS}
              aria-label={lagFieldLabelFor(label)}
              title={LAG_FIELD_HINT}
              onBlur={(e) => {
                const newLag = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(newLag) && newLag !== link.lag) {
                  setRowError(null);
                  onUpdate({ lag: newLag });
                }
              }}
              className="w-14 text-xs border border-neutral-border rounded-control px-1.5 py-1 text-center
              bg-neutral-surface text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
            <span className="text-xs text-neutral-text-secondary shrink-0">{LAG_UNIT_SUFFIX}</span>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Remove dependency on ${relatedTask.name}`}
              className="w-6 h-6 flex items-center justify-center rounded-control text-neutral-text-disabled
              hover:text-semantic-critical
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              ×
            </button>
          </>
        )}
      </div>
      {rowError && (
        <span role="alert" className="block text-xs text-semantic-critical pb-1.5">
          {rowError}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddDepRow
// ---------------------------------------------------------------------------

interface AddDepRowProps {
  availableTasks: Task[];
  selectedTaskId: string;
  selectedType: LinkType;
  /**
   * Lag for the edge about to be created, as TEXT — same reason as the picker
   * (#3023): a number state has to decide what the emptied field means and
   * every answer is wrong. `clampLagDays` resolves "" and a lone "-" to 0 in
   * one place.
   */
  lagText: string;
  isPending: boolean;
  onTaskChange: (id: string) => void;
  onTypeChange: (type: LinkType) => void;
  onLagChange: (text: string) => void;
  /**
   * Which side this add-row builds. Names its controls, because the drawer
   * renders TWO add-rows — one per section — and "Lag days" on both is the same
   * ambiguity the per-link rows had (#2916). An explicit prop rather than a
   * regex over `addLabel`: deriving a control's accessible name by string
   * surgery on another label is how the two drift.
   */
  relation: 'predecessor' | 'successor';
  onAdd: () => void;
  addLabel: string;
}

function AddDepRow({
  availableTasks,
  selectedTaskId,
  selectedType,
  lagText,
  isPending,
  onTaskChange,
  onTypeChange,
  onLagChange,
  onAdd,
  addLabel,
  relation,
}: AddDepRowProps) {
  const target = `new ${relation}`;
  return (
    <div className="flex items-center gap-2 mt-2">
      <select
        value={selectedTaskId}
        onChange={(e) => onTaskChange(e.target.value)}
        aria-label={addLabel}
        className="flex-1 min-w-0 text-xs border border-neutral-border rounded-control px-2 py-1
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <option value="">— {addLabel} —</option>
        {availableTasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.wbs ? `${t.wbs} — ${t.name}` : t.name}
          </option>
        ))}
      </select>
      <select
        value={selectedType}
        onChange={(e) => onTypeChange(e.target.value as LinkType)}
        aria-label={linkTypeFieldLabel(target)}
        className="text-xs border border-neutral-border rounded-control px-1.5 py-1
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {DEP_TYPES.map((dt) => (
          <option key={dt.value} value={dt.value}>
            {dt.label}
          </option>
        ))}
      </select>
      {/* Lag at CREATE (#2916). The drawer could already choose all four types
          here but not a lag, so an SS+2d edge — the normal shape in a
          phase-gated program — was create-then-edit even on the surface this
          ADR-0052 §8 names as the place deeper editing lives. */}
      <input
        type="number"
        value={lagText}
        min={LAG_MIN_DAYS}
        max={LAG_MAX_DAYS}
        aria-label={lagFieldLabelFor(target)}
        title={LAG_FIELD_HINT}
        onChange={(e) => onLagChange(e.target.value)}
        className="w-14 text-xs border border-neutral-border rounded-control px-1.5 py-1 text-center
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="text-xs text-neutral-text-secondary shrink-0">{LAG_UNIT_SUFFIX}</span>
      <button
        type="button"
        onClick={onAdd}
        disabled={!selectedTaskId || isPending}
        aria-label={addLabel}
        className="h-7 px-3 rounded-control text-xs font-medium border border-neutral-border
          text-neutral-text-secondary hover:text-neutral-text-primary hover:border-brand-primary
          disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Add
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CrossProjectSearchLink
// ---------------------------------------------------------------------------

/**
 * The inline dropdowns above only ever list this project's tasks (ADR-0050 —
 * the section reads from the project-scoped schedule cache). This link opens
 * the same cross-project picker the schedule canvas's right-click menu uses
 * (ADR-0120), landed on Program scope, so a program task is reachable from
 * the drawer too.
 */
function CrossProjectSearchLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 inline-flex min-h-[44px] items-center text-xs text-brand-primary hover:underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control"
    >
      Search another project in this program…
    </button>
  );
}
