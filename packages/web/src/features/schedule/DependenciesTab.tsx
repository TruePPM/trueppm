import { useState, useEffect } from 'react';
import type { Task, TaskLink, LinkType } from '@/types';
import {
  useCreateDependency,
  useUpdateDependency,
  useDeleteDependency,
} from '@/hooks/useDependencyMutations';
import { parseCyclicDependencyError, formatCycleMessage } from '@/hooks/useTaskMutations';

const DEP_TYPES: { value: LinkType; label: string }[] = [
  { value: 'FS', label: 'Finish → Start' },
  { value: 'SS', label: 'Start → Start' },
  { value: 'FF', label: 'Finish → Finish' },
  { value: 'SF', label: 'Start → Finish' },
];

interface DependenciesTabProps {
  task: Task;
  tasks: Task[];
  links: TaskLink[];
  projectId: string;
}

export function DependenciesTab({ task, tasks, links, projectId }: DependenciesTabProps) {
  const createDep = useCreateDependency(projectId);
  const updateDep = useUpdateDependency(projectId);
  const deleteDep = useDeleteDependency(projectId);

  const [addPredId, setAddPredId] = useState('');
  const [addPredType, setAddPredType] = useState<LinkType>('FS');
  const [addSuccId, setAddSuccId] = useState('');
  const [addSuccType, setAddSuccType] = useState<LinkType>('FS');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setAddPredId('');
    setAddPredType('FS');
    setAddSuccId('');
    setAddSuccType('FS');
    setErrorMessage(null);
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
      { predecessor: addPredId, successor: taskId, dep_type: addPredType },
      {
        onSuccess: () => { setAddPredId(''); setAddPredType('FS'); },
        // Cycle errors keep the predecessor selection intact so the user can
        // adjust without re-picking from the dropdown (#356 AC).
        onError: (err) => {
          const cycle = parseCyclicDependencyError(err);
          setErrorMessage(cycle ? formatCycleMessage(cycle) : 'Couldn’t add dependency. Try again.');
        },
      },
    );
  }

  function handleAddSucc() {
    if (!addSuccId) return;
    setErrorMessage(null);
    createDep.mutate(
      { predecessor: taskId, successor: addSuccId, dep_type: addSuccType },
      {
        onSuccess: () => { setAddSuccId(''); setAddSuccType('FS'); },
        onError: (err) => {
          const cycle = parseCyclicDependencyError(err);
          setErrorMessage(cycle ? formatCycleMessage(cycle) : 'Couldn’t add dependency. Try again.');
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
            />
          );
        })}
        <AddDepRow
          availableTasks={availableAsPred}
          selectedTaskId={addPredId}
          selectedType={addPredType}
          isPending={createDep.isPending}
          onTaskChange={setAddPredId}
          onTypeChange={setAddPredType}
          onAdd={handleAddPred}
          addLabel="Add predecessor"
        />
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
            />
          );
        })}
        <AddDepRow
          availableTasks={availableAsSucc}
          selectedTaskId={addSuccId}
          selectedType={addSuccType}
          isPending={createDep.isPending}
          onTaskChange={setAddSuccId}
          onTypeChange={setAddSuccType}
          onAdd={handleAddSucc}
          addLabel="Add successor"
        />
      </section>

      {errorMessage && (
        <div
          role="alert"
          className="bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical text-xs px-3 py-2 rounded"
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
}

function DepRow({ link, relatedTask, onUpdate, onDelete }: DepRowProps) {
  const [rowError, setRowError] = useState<string | null>(null);
  const label = relatedTask.wbs
    ? `${relatedTask.wbs} — ${relatedTask.name}`
    : relatedTask.name;

  return (
    <div className="border-b border-neutral-border/40 last:border-b-0">
      <div className="flex items-center gap-2 py-1.5">
        <span className="flex-1 text-sm text-neutral-text-primary truncate" title={label}>
          {label}
        </span>
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
          aria-label="Dependency type"
          className="text-xs border border-neutral-border rounded px-1.5 py-1
            bg-neutral-surface text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {DEP_TYPES.map((dt) => (
            <option key={dt.value} value={dt.value}>{dt.label}</option>
          ))}
        </select>
        <input
          key={`${link.id}-lag-${link.lag}`}
          type="number"
          defaultValue={link.lag}
          min={-365}
          max={365}
          aria-label="Lag days"
          title="Lag in days (negative = lead)"
          onBlur={(e) => {
            const newLag = parseInt(e.target.value, 10);
            if (!isNaN(newLag) && newLag !== link.lag) {
              setRowError(null);
              onUpdate({ lag: newLag });
            }
          }}
          className="w-14 text-xs border border-neutral-border rounded px-1.5 py-1 text-center
            bg-neutral-surface text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <span className="text-xs text-neutral-text-disabled shrink-0">d lag</span>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Remove dependency on ${relatedTask.name}`}
          className="w-6 h-6 flex items-center justify-center rounded text-neutral-text-disabled
            hover:text-semantic-critical
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ×
        </button>
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
  isPending: boolean;
  onTaskChange: (id: string) => void;
  onTypeChange: (type: LinkType) => void;
  onAdd: () => void;
  addLabel: string;
}

function AddDepRow({
  availableTasks,
  selectedTaskId,
  selectedType,
  isPending,
  onTaskChange,
  onTypeChange,
  onAdd,
  addLabel,
}: AddDepRowProps) {
  return (
    <div className="flex items-center gap-2 mt-2">
      <select
        value={selectedTaskId}
        onChange={(e) => onTaskChange(e.target.value)}
        aria-label={addLabel}
        className="flex-1 min-w-0 text-xs border border-neutral-border rounded px-2 py-1
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
        aria-label="Link type"
        className="text-xs border border-neutral-border rounded px-1.5 py-1
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {DEP_TYPES.map((dt) => (
          <option key={dt.value} value={dt.value}>{dt.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onAdd}
        disabled={!selectedTaskId || isPending}
        aria-label={addLabel}
        className="h-7 px-3 rounded text-xs font-medium border border-neutral-border
          text-neutral-text-secondary hover:text-neutral-text-primary hover:border-brand-primary
          disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Add
      </button>
    </div>
  );
}
