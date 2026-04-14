import { type RefObject, useEffect, useRef, useState } from 'react';
import type { Task, TaskLink, LinkType } from '@/types';
import {
  useCreateDependency,
  useUpdateDependency,
  useDeleteDependency,
} from '@/hooks/useDependencyMutations';
import { ResourceAssignmentSection } from './ResourceAssignmentSection';

export interface TaskDetailDrawerProps {
  task: Task | null;
  tasks: Task[];
  links: TaskLink[];
  projectId: string;
  onClose: () => void;
}

const DEP_TYPES: { value: LinkType; label: string }[] = [
  { value: 'FS', label: 'FS — Finish to Start' },
  { value: 'SS', label: 'SS — Start to Start' },
  { value: 'FF', label: 'FF — Finish to Finish' },
  { value: 'SF', label: 'SF — Start to Finish' },
];

export function TaskDetailDrawer({
  task,
  tasks,
  links,
  projectId,
  onClose,
}: TaskDetailDrawerProps) {
  const isOpen = task !== null;
  const drawerTitle = task ? `${task.wbs ? task.wbs + ' — ' : ''}${task.name}` : '';

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef      = useRef<HTMLDivElement>(null);

  // Focus close button when drawer opens
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, task?.id]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return undefined;

    function trapFocus(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen]);

  const drawerContent = (
    <DrawerBody
      task={task}
      tasks={tasks}
      links={links}
      projectId={projectId}
      closeButtonRef={closeButtonRef}
      drawerTitle={drawerTitle}
      onClose={onClose}
    />
  );

  return (
    <>
      {/* Backdrop — mobile only (rule 89) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop drawer — 480px right-side slide-in (rule 89) */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[480px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          'transition-transform duration-200',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {drawerContent}
      </div>

      {/* Mobile bottom sheet — 85vh (rule 89) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-xl bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
          'transition-transform duration-200',
          isOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        <div className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0" aria-hidden="true" />
        {drawerContent}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// DrawerBody — shared between desktop and mobile shells
// ---------------------------------------------------------------------------

interface DrawerBodyProps {
  task: Task | null;
  tasks: Task[];
  links: TaskLink[];
  projectId: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  drawerTitle: string;
  onClose: () => void;
}

function DrawerBody({
  task,
  tasks,
  links,
  projectId,
  closeButtonRef,
  drawerTitle,
  onClose,
}: DrawerBodyProps) {
  const createDep = useCreateDependency(projectId);
  const updateDep = useUpdateDependency(projectId);
  const deleteDep = useDeleteDependency(projectId);

  // Local state for the two "add" forms
  const [addPredId,   setAddPredId]   = useState('');
  const [addPredType, setAddPredType] = useState<LinkType>('FS');
  const [addSuccId,   setAddSuccId]   = useState('');
  const [addSuccType, setAddSuccType] = useState<LinkType>('FS');

  // Reset add-form state when the selected task changes
  useEffect(() => {
    setAddPredId('');
    setAddPredType('FS');
    setAddSuccId('');
    setAddSuccType('FS');
  }, [task?.id]);

  if (!task) return null;

  // Build predecessor/successor lists from the global links array
  const predecessorLinks = links.filter((l) => l.targetId === task.id);
  const successorLinks   = links.filter((l) => l.sourceId === task.id);

  const linkedPredIds = new Set(predecessorLinks.map((l) => l.sourceId));
  const linkedSuccIds = new Set(successorLinks.map((l) => l.targetId));

  // Tasks eligible to add as predecessor/successor (exclude self + already linked)
  const availableAsPred = tasks.filter(
    (t) => t.id !== task.id && !linkedPredIds.has(t.id),
  );
  const availableAsSucc = tasks.filter(
    (t) => t.id !== task.id && !linkedSuccIds.has(t.id),
  );

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Capture the non-null task.id so closures don't widen back to Task | null
  const taskId = task.id;

  function handleAddPred() {
    if (!addPredId) return;
    createDep.mutate(
      { predecessor: addPredId, successor: taskId, dep_type: addPredType },
      { onSuccess: () => { setAddPredId(''); setAddPredType('FS'); } },
    );
  }

  function handleAddSucc() {
    if (!addSuccId) return;
    createDep.mutate(
      { predecessor: taskId, successor: addSuccId, dep_type: addSuccType },
      { onSuccess: () => { setAddSuccId(''); setAddSuccType('FS'); } },
    );
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-neutral-border shrink-0">
        <h2
          className="text-base font-semibold text-neutral-text-primary truncate pr-2"
          title={drawerTitle}
        >
          {drawerTitle}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close task detail"
          className="w-8 h-8 flex items-center justify-center rounded text-neutral-text-secondary
            hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">

        {/* Resource Assignments */}
        <ResourceAssignmentSection taskId={taskId} projectId={projectId} />

        {/* Predecessors */}
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
                onUpdate={(patch) => updateDep.mutate({ id: link.id, ...patch })}
                onDelete={() => deleteDep.mutate(link.id)}
              />
            );
          })}

          {/* Add predecessor */}
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

        {/* Successors */}
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
                onUpdate={(patch) => updateDep.mutate({ id: link.id, ...patch })}
                onDelete={() => deleteDep.mutate(link.id)}
              />
            );
          })}

          {/* Add successor */}
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

        {/* Scheduling note */}
        <p className="text-xs text-neutral-text-disabled border-t border-neutral-border pt-4">
          Successors are automatically rescheduled by the CPM engine after dependency changes.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// DepRow — one existing dependency
// ---------------------------------------------------------------------------

interface DepRowProps {
  link: TaskLink;
  relatedTask: Task;
  onUpdate: (patch: { dep_type?: LinkType; lag?: number }) => void;
  onDelete: () => void;
}

function DepRow({ link, relatedTask, onUpdate, onDelete }: DepRowProps) {
  const label = relatedTask.wbs
    ? `${relatedTask.wbs} — ${relatedTask.name}`
    : relatedTask.name;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-neutral-border/40 last:border-b-0">
      {/* Task name */}
      <span
        className="flex-1 text-sm text-neutral-text-primary truncate"
        title={label}
      >
        {label}
      </span>

      {/* Dependency type */}
      <select
        value={link.type}
        onChange={(e) => onUpdate({ dep_type: e.target.value as LinkType })}
        aria-label="Dependency type"
        className="text-xs border border-neutral-border rounded px-1.5 py-1
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {DEP_TYPES.map((dt) => (
          <option key={dt.value} value={dt.value}>{dt.value}</option>
        ))}
      </select>

      {/* Lag (uncontrolled; key resets the input when server data changes) */}
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
            onUpdate({ lag: newLag });
          }
        }}
        className="w-14 text-xs border border-neutral-border rounded px-1.5 py-1 text-center
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="text-xs text-neutral-text-disabled shrink-0">d lag</span>

      {/* Delete */}
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
  );
}

// ---------------------------------------------------------------------------
// AddDepRow — add a new predecessor or successor
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
      {/* Task picker */}
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

      {/* Type */}
      <select
        value={selectedType}
        onChange={(e) => onTypeChange(e.target.value as LinkType)}
        aria-label="Link type"
        className="text-xs border border-neutral-border rounded px-1.5 py-1
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {DEP_TYPES.map((dt) => (
          <option key={dt.value} value={dt.value}>{dt.value}</option>
        ))}
      </select>

      {/* Add button */}
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
