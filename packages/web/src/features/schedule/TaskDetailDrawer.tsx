import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { Task } from '@/types';
import {
  registry,
  type DrawerSectionRegistration,
  type DrawerSectionTab,
} from '@/lib/widget-registry';
import { useNavigate } from 'react-router';
import {
  DialogFooter,
  UnsavedChangesDialog,
  useDirtyDraft,
  useUnsavedChangesGuard,
} from '@/components/dialog';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditTask } from '@/lib/roles';
import { ReadinessChip } from '../board/ReadinessChip';
import { CollapsibleSection } from './sections/CollapsibleSection';
import { SectionErrorBoundary } from './sections/SectionErrorBoundary';
import { TaskScheduleStrip } from './TaskScheduleStrip';
import { TaskDescriptionField } from './TaskDescriptionField';
import { registerOssDrawerSections } from './sections';

// Register OSS sections at module init — Enterprise registers in its own
// init module. Both must run before the first drawer render; both are
// idempotent so the order doesn't matter.
registerOssDrawerSections();

/** Fixed tab order for the redesigned drawer (#962). */
const TAB_DEFS: ReadonlyArray<{ id: DrawerSectionTab; label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'subtasks', label: 'Subtasks' },
  { id: 'activity', label: 'Activity' },
  { id: 'files', label: 'Files' },
];

/**
 * The task's own scalar columns that batch behind the Save/Cancel bar (#1977).
 * Everything else — status, progress, assignees, labels, and every registry
 * section (estimates, dependencies, sprint, …) — mutates immediately through
 * its own endpoint (the web-rule 217 carve-out for instant-toggle / relational
 * controls), so only these two live in the deferred draft.
 */
interface ScalarDraft {
  name: string;
  notes: string;
}

const EMPTY_DRAFT: ScalarDraft = { name: '', notes: '' };

function toDraft(task: Task): ScalarDraft {
  return { name: task.name, notes: task.notes ?? '' };
}

export interface TaskDetailDrawerProps {
  task: Task | null;
  projectId: string;
  onClose: () => void;
  /**
   * Optional context passed to each section's `canRender(ctx)` predicate.
   * Sections use this to hide entirely when a feature is not licensed/available;
   * pass the current user object so Enterprise sections can gate visibility.
   */
  sectionContext?: { user?: unknown };
}

/**
 * Right-side slide-in drawer hosting registry-driven sections grouped into four
 * tabs — Details / Subtasks / Activity / Files (#962, "Direction B").
 *
 * The tab is a presentation grouping layered on top of the ADR-0050 priority
 * ladder: sections still register against `task_detail.section` with a
 * priority and a `tab` (defaulting to `details` for backward compatibility, so
 * Enterprise-registered sections keep rendering). Within a tab the first
 * section is expanded and the rest start collapsed, preserving ADR-0050's
 * lazy-load (a section's TanStack Query hooks fire only when its tab is active
 * and it is expanded).
 *
 * Edit model (#1977): the task's own scalar columns — name and description —
 * batch behind an explicit Save/Cancel bar built on the shared `@/components/
 * dialog` primitives (`useDirtyDraft` + `useUnsavedChangesGuard` + `DialogFooter`
 * + `UnsavedChangesDialog`), the same contract StoryDetailDrawer uses (web-rule
 * 217). There is no auto-flush: Esc / close / expand while dirty raise the
 * unsaved-changes guard instead of silently saving, and switching tabs keeps the
 * draft intact. Everything else — status, progress, assignees, labels, and every
 * registry section — keeps its immediate mutation (the rule-217 carve-out), so
 * only name/description can ever raise the bar.
 *
 * Container note (#1977): the desktop shell stays a focus-trapped, aria-modal
 * overlay for now; converting it to a true non-modal inspector is tracked
 * separately (#1978).
 *
 * Desktop ≥ md: 540px slide-in. Mobile < md: 85vh bottom sheet.
 */
export function TaskDetailDrawer({
  task,
  projectId,
  onClose,
  sectionContext,
}: TaskDetailDrawerProps) {
  const isOpen = task !== null;
  const drawerTitle = task ? `${task.wbs ? task.wbs + ' — ' : ''}${task.name}` : '';

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const { tasks: allTasks } = useScheduleTasks();
  const { mutate: updateTask, isPending: isSaving, isError: saveFailed } = useUpdateTask();
  // 1046: thread the viewer's project role into the sections so write controls
  // (add link, add attachment, edit description) are hidden from Viewers instead
  // of surfacing affordances that 403 on submit. `role` is null while it loads.
  const { role: userRole } = useCurrentUserRole(projectId);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<DrawerSectionTab>('details');

  // Deferred scalar form (name + description) on the shared editable-surface
  // contract (web-rule 217). draft/baseline/dirty + revert + post-save
  // re-snapshot come from the hook; only these two columns batch behind Save.
  const { draft, setField, baseline, dirty, reset, commit } = useDirtyDraft<ScalarDraft>(
    task ? toDraft(task) : EMPTY_DRAFT,
  );

  // Re-seed the draft when the *identity* of the rendered task changes (opened
  // or canvas-swapped to a different task). A server-side update to the SAME
  // task never reseeds — useDirtyDraft deliberately does not auto-resync, so a
  // collaborator's WebSocket edit can't clobber an in-progress draft (it
  // surfaces as the concurrent-edit banner instead). Also resets to Details.
  const taskId = task?.id;
  useEffect(() => {
    if (task) commit(toDraft(task));
    setActiveTab('details');
    // Only identity changes reseed; `commit` is stable and `task` is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Concurrent-edit signal: the live task's notes drifted from the value we
  // opened/last-saved from AND from what the user has typed — someone else saved
  // while this draft was open. Warn rather than clobber.
  const notesChangedElsewhere =
    task !== null &&
    dirty &&
    (task.notes ?? '') !== baseline.notes &&
    (task.notes ?? '') !== draft.notes;

  // Save = one PATCH carrying only the changed scalar keys, then re-snapshot the
  // baseline on success so the bar clears without waiting on a refetch.
  const handleSave = useCallback(() => {
    if (!task) return;
    const patch: { name?: string; notes?: string } = {};
    if (draft.name !== baseline.name) patch.name = draft.name;
    if (draft.notes !== baseline.notes) patch.notes = draft.notes;
    if (Object.keys(patch).length === 0) return;
    updateTask({ id: task.id, projectId, ...patch }, { onSuccess: () => commit() });
  }, [task, projectId, draft, baseline, updateTask, commit]);

  // Expand → full-page focus view (ADR-0124). A dirty draft is guarded on its
  // own path so Discard navigates to a fresh editable load (Keep editing stays).
  // Declared before the close guard so its Escape listener can stand down while
  // this guard is up (see escapeToClose below).
  const [expandGuardOpen, setExpandGuardOpen] = useState(false);

  // Close / Esc: prompt the unsaved-changes guard when dirty, else close. Revert
  // the draft on close so reopening the same task (identity unchanged → no
  // reseed) never flashes a stale dirty draft. Suspend the guard's document
  // Escape listener while the expand guard is showing — otherwise Esc there
  // would also fire requestClose and silently swap the expand prompt (whose
  // Discard navigates) for the close prompt (whose Discard just closes).
  const closeAndReset = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty,
    onClose: closeAndReset,
    escapeToClose: isOpen && !expandGuardOpen,
  });

  const doExpand = useCallback(() => {
    if (!task) return;
    reset();
    onClose();
    void navigate(`/projects/${projectId}/tasks/${task.id}`);
  }, [task, projectId, reset, onClose, navigate]);
  const handleExpand = useCallback(() => {
    if (dirty) setExpandGuardOpen(true);
    else doExpand();
  }, [dirty, doExpand]);

  // Tab-switch keeps the dirty draft intact — the bar docks below the tabpanel,
  // so nothing is lost or silently saved when moving between tabs.
  const changeTab = useCallback((next: DrawerSectionTab) => {
    setActiveTab(next);
  }, []);

  // Cmd/Ctrl+S saves when dirty (matches the settings shell). Only intercept the
  // browser "save page" shortcut when there is actually something to save.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        if (!dirty) return;
        e.preventDefault();
        handleSave();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, dirty, handleSave]);

  // Move focus to Close on open so keyboard users land somewhere sensible.
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, taskId]);

  // Esc is owned by the unsaved-changes guard (escapeToClose) so a dirty drawer
  // prompts instead of closing — no separate Esc effect here.

  // Focus trap inside drawer when open — preserved from prior drawer. Suspended
  // while a guard dialog is up so its own trap owns the Tab cycle (the pattern
  // StoryDetailDrawer uses).
  useEffect(() => {
    if (!isOpen || guardOpen || expandGuardOpen) return undefined;
    function trapFocus(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen, guardOpen, expandGuardOpen]);

  // Read sections from the registry once per render. The registry sorts by
  // priority on register() so no sort here. Filter by canRender so Enterprise
  // sections that gate on license disappear cleanly.
  const sections = useMemo(() => {
    if (!task) return [];
    // A phase — a summary that groups real WBS work — has at least one structural
    // (non-subtask) child. The Subtasks section gates on this so its tab is hidden
    // on a phase but stays visible on a leaf that already has subtasks (#1750).
    const hasStructuralChildren = (allTasks ?? []).some(
      (t) => t.parentId === task.id && t.isSubtask !== true,
    );
    const ctx = { user: sectionContext?.user, task, hasStructuralChildren };
    return (registry.get('task_detail.section') as DrawerSectionRegistration[]).filter(
      (s) => !s.canRender || s.canRender(ctx),
    );
  }, [task, sectionContext?.user, allTasks]);

  // Group the filtered sections by tab (default `details`), preserving the
  // priority order the registry already sorted them into.
  const sectionsByTab = useMemo(() => {
    const map: Record<DrawerSectionTab, DrawerSectionRegistration[]> = {
      details: [],
      subtasks: [],
      activity: [],
      files: [],
    };
    for (const s of sections) map[s.tab ?? 'details'].push(s);
    return map;
  }, [sections]);

  // Subtask done/total for the Subtasks tab badge — derived from the already
  // loaded schedule cache so it costs no extra fetch (an Activity/Files count
  // would force eager fetching, which ADR-0050's lazy-load deliberately avoids).
  const subtaskStats = useMemo(() => {
    if (!task) return { total: 0, done: 0 };
    const subs = (allTasks ?? []).filter((t) => t.parentId === task.id && t.isSubtask === true);
    return {
      total: subs.length,
      done: subs.filter((t) => t.status === 'COMPLETE').length,
    };
    // Only the task identity matters for which children to count, not every
    // field mutation on the task object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks, task?.id]);

  // Hide a non-details tab that has no registered sections (e.g. Subtasks for a
  // milestone — its section's canRender returns false). Details always shows
  // (it carries the schedule strip + description).
  const visibleTabs = TAB_DEFS.filter((t) => t.id === 'details' || sectionsByTab[t.id].length > 0);

  const content = task && (
    <DrawerContent
      task={task}
      projectId={projectId}
      userRole={userRole}
      drawerTitle={drawerTitle}
      closeButtonRef={closeButtonRef}
      onRequestClose={requestClose}
      onExpand={handleExpand}
      tabs={visibleTabs}
      activeTab={activeTab}
      onTabChange={changeTab}
      sectionsByTab={sectionsByTab}
      subtaskStats={subtaskStats}
      draftName={draft.name}
      onNameChange={(v) => setField('name', v)}
      changedName={draft.name !== baseline.name}
      draftNotes={draft.notes}
      onNotesChange={(v) => setField('notes', v)}
      changedNotes={draft.notes !== baseline.notes}
      notesChangedElsewhere={notesChangedElsewhere}
      dirty={dirty}
      isSaving={isSaving}
      saveFailed={saveFailed}
      onSave={handleSave}
      onCancel={reset}
    />
  );

  return (
    <>
      {/* Mobile backdrop — requests close (guarded when dirty); desktop has no backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={requestClose}
        />
      )}

      {/* Desktop: 540px right-side slide-in.
          aria-modal="true" because a Tab focus trap is active while the drawer is
          open (see the trapFocus effect) — keyboard focus cannot reach the canvas,
          so the drawer is modal in fact and must announce itself as such. */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[540px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          // v2 fluidity (ADR-0126, rule 185): slide on the brand ease (proto .26s).
          // motion-safe so users (and e2e, #1655) with prefers-reduced-motion get
          // an instant snap instead of a transform that Playwright's stability
          // check races against.
          'motion-safe:transition-transform duration-slow ease-brand',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {content}
      </div>

      {/* Mobile: 85vh bottom sheet — preserves prior shell */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-card bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
          'motion-safe:transition-transform duration-200',
          isOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        <div
          className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0"
          aria-hidden="true"
        />
        {content}
      </div>

      {/* Unsaved-changes guard — shared prompt (web-rule 217). One instance for
          the close/Esc/backdrop path, a second for expand so Discard navigates
          to the full page rather than merely closing. */}
      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
      {expandGuardOpen && (
        <UnsavedChangesDialog
          onKeepEditing={() => setExpandGuardOpen(false)}
          onDiscard={() => {
            setExpandGuardOpen(false);
            doExpand();
          }}
        />
      )}
    </>
  );
}

interface DrawerContentProps {
  task: Task;
  projectId: string;
  userRole?: number | null;
  drawerTitle: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
  onExpand: () => void;
  tabs: ReadonlyArray<{ id: DrawerSectionTab; label: string }>;
  activeTab: DrawerSectionTab;
  onTabChange: (tab: DrawerSectionTab) => void;
  sectionsByTab: Record<DrawerSectionTab, DrawerSectionRegistration[]>;
  subtaskStats: { total: number; done: number };
  draftName: string;
  onNameChange: (value: string) => void;
  changedName: boolean;
  draftNotes: string;
  onNotesChange: (value: string) => void;
  changedNotes: boolean;
  notesChangedElsewhere: boolean;
  dirty: boolean;
  isSaving: boolean;
  saveFailed: boolean;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Header + tab strip + active-tab body + save bar, rendered inside both the
 * desktop slide-in and the mobile bottom-sheet shells.
 */
function DrawerContent({
  task,
  projectId,
  userRole,
  drawerTitle,
  closeButtonRef,
  onRequestClose,
  onExpand,
  tabs,
  activeTab,
  onTabChange,
  sectionsByTab,
  subtaskStats,
  draftName,
  onNameChange,
  changedName,
  draftNotes,
  onNotesChange,
  changedNotes,
  notesChangedElsewhere,
  dirty,
  isSaving,
  saveFailed,
  onSave,
  onCancel,
}: DrawerContentProps) {
  // Which staged fields changed — names the bar's scope for sighted users (the
  // per-field • markers) and for AT (the sr-only live region below).
  const changedLabels = [changedName ? 'Name' : null, changedNotes ? 'Description' : null].filter(
    Boolean,
  ) as string[];
  const statusText = changedLabels.length
    ? `Unsaved changes: ${changedLabels.join(', ')}`
    : 'Unsaved changes';
  // WAI-ARIA tab pattern (#1022): ArrowLeft/Right move selection+focus across
  // the tablist so a keyboard user reaches a sibling tab without Tab-cycling
  // through the active panel's content. Focus follows selection (automatic
  // activation) since switching tabs is cheap here.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Last Description textarea scrollTop, kept alive across tab switches (issue
  // 1048). DrawerContent stays mounted while the drawer is open, but the Details
  // panel — and the Description field inside it — unmounts when another tab is
  // active, so the scroll cache has to live one level up from the field. Reset
  // it when the task identity changes so a long scroll doesn't leak to the next
  // task opened in the same drawer.
  const descScrollRef = useRef(0);
  useEffect(() => {
    descScrollRef.current = 0;
  }, [task.id]);

  const handleTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === activeTab);
    if (idx === -1) return;
    const nextIdx =
      e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    const nextId = tabs[nextIdx].id;
    onTabChange(nextId);
    tabRefs.current[nextId]?.focus();
  };

  // Effective edit/delete capability for this drawer (ADR-0133, 1144). Prefer
  // the server-derived per-task verdict; fall back to the client role rule only
  // when the field is absent (pre-field synced rows / optimistic local creates),
  // so a Viewer never sees a flash of editable controls and Scheduler /
  // Member-on-others-tasks / PO cases the client rule gets wrong are corrected.
  const canEdit = task.canEdit ?? canEditTask(userRole);

  return (
    <>
      {/* Header — chips row, editable name, tab strip */}
      <div className="shrink-0 px-4 pt-3 border-b border-neutral-border bg-neutral-surface">
        <div className="flex items-center gap-2 mb-2">
          {task.wbs && (
            <span className="tppm-mono text-xs font-semibold text-neutral-text-secondary px-1.5 py-0.5 rounded-chip bg-neutral-surface-sunken">
              {task.wbs}
            </span>
          )}
          {task.readiness && <ReadinessChip readiness={task.readiness} />}
          {task.isCritical && (
            <span
              className="text-xs font-semibold text-white bg-semantic-critical px-1.5 py-0.5 rounded-chip"
              title="This task is on the critical path — a delay here delays the project end date"
            >
              CP
            </span>
          )}
          {/* "View only" indicator (ADR-0133, 1143). A muted, neutral read-state
              chip — not a warning — present whenever the drawer is non-editable,
              so the absence of write controls is never ambiguous ("is it a bug or
              am I not allowed?"). The lock glyph is decorative; the accessible
              name carries the full reason. */}
          {!canEdit && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium text-neutral-text-secondary bg-neutral-surface-sunken px-1.5 py-0.5 rounded-chip"
              title="Viewer access — ask an admin for edit access"
              aria-label="View only — Viewer access, ask an admin for edit access"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              View only
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand to full page"
            title="Expand to full page"
            className="w-11 h-11 flex items-center justify-center rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onRequestClose}
            aria-label="Close task detail"
            className="w-11 h-11 -mr-1.5 flex items-center justify-center rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ×
          </button>
        </div>

        {/* Hidden heading keeps the dialog's accessible structure + gives tests
            a stable title node; the visible title is an inline editable input. */}
        <h2 className="sr-only">{drawerTitle}</h2>
        <div className="flex items-baseline gap-1.5 mb-2">
          <input
            aria-label="Task name"
            value={draftName}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            // ADR-0133/1142: the title is read-only for non-editors. A readOnly
            // input renders as plain text (bg-transparent, no border) and drops the
            // edit focus ring + caret so it never invites an edit that would 403.
            readOnly={!canEdit}
            className={[
              'min-w-0 flex-1 bg-transparent border-none outline-none px-0',
              'text-xl font-semibold tracking-tight text-neutral-text-primary rounded-control',
              canEdit
                ? 'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1'
                : 'cursor-default focus:outline-none',
            ].join(' ')}
          />
          {/* Unsaved marker — decorative; the sr-only status region carries the
              accessible "unsaved changes in Name" announcement. */}
          {changedName && (
            <span
              aria-hidden="true"
              title="Unsaved"
              className="shrink-0 text-lg leading-none text-brand-primary"
            >
              •
            </span>
          )}
        </div>

        {/* Tabs — arrow-key handling lives on each focusable tab button rather
            than the tablist (the tablist itself is not a tab stop). */}
        <div role="tablist" aria-label="Task detail sections" className="flex gap-1 -mb-px">
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            const showCount = tab.id === 'subtasks' && subtaskStats.total > 0;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                type="button"
                role="tab"
                id={`drawer-tab-${tab.id}`}
                aria-controls={`drawer-panel-${tab.id}`}
                aria-selected={selected}
                // Roving tabindex: the tablist is a single Tab stop; ArrowLeft/
                // Right move between tabs (WAI-ARIA tab pattern).
                tabIndex={selected ? 0 : -1}
                onKeyDown={handleTabKeyDown}
                onClick={() => onTabChange(tab.id)}
                className={[
                  'inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:rounded-control',
                  selected
                    ? 'border-brand-primary text-brand-primary font-semibold'
                    : 'border-transparent text-neutral-text-secondary font-medium hover:text-neutral-text-primary',
                ].join(' ')}
              >
                {tab.label}
                {showCount && (
                  <span className="tppm-mono text-xs px-1 rounded-chip bg-neutral-surface-sunken text-neutral-text-secondary">
                    {subtaskStats.done}/{subtaskStats.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active-tab body — labelled by the active tab so AT announces the
          panel/tab relationship (#1022). Only the active panel is rendered. */}
      <div
        role="tabpanel"
        id={`drawer-panel-${activeTab}`}
        aria-labelledby={`drawer-tab-${activeTab}`}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      >
        {activeTab === 'details' &&
          (() => {
            // The Details tab is a curated layout (#962): the schedule strip,
            // the Overview section's work-state (status/progress/people)
            // rendered inline rather than behind an "Overview" accordion, and
            // the deferred Description. The remaining registered details
            // sections (sprint, dependencies, recurrence, estimates, and any
            // Enterprise sections) render as collapsed accordions below.
            const overview = sectionsByTab.details.find((s) => s.id === 'overview');
            const OverviewComp = overview?.component;
            const rest = sectionsByTab.details.filter((s) => s.id !== 'overview');
            return (
              <div>
                <div className="px-4 py-4 space-y-5">
                  <TaskScheduleStrip task={task} />
                  {OverviewComp && (
                    <SectionErrorBoundary sectionTitle="Overview">
                      <OverviewComp
                        taskId={task.id}
                        projectId={projectId}
                        userRole={userRole}
                        canEdit={canEdit}
                      />
                    </SectionErrorBoundary>
                  )}
                  <TaskDescriptionField
                    value={draftNotes}
                    onChange={onNotesChange}
                    changed={changedNotes}
                    changedElsewhere={notesChangedElsewhere}
                    readOnly={!canEdit}
                    scrollTopRef={descScrollRef}
                  />
                </div>
                <SectionList
                  sections={rest}
                  taskId={task.id}
                  projectId={projectId}
                  userRole={userRole}
                  canEdit={canEdit}
                  firstOpen={false}
                />
              </div>
            );
          })()}

        {activeTab !== 'details' && (
          <SectionList
            sections={sectionsByTab[activeTab]}
            taskId={task.id}
            projectId={projectId}
            userRole={userRole}
            canEdit={canEdit}
          />
        )}
      </div>

      {/* AT announcement of the bar's scope — which staged fields are unsaved.
          A polite live region so it never interrupts the user mid-type. */}
      <div className="sr-only" role="status" aria-live="polite">
        {dirty ? statusText : ''}
      </div>

      {/* Save bar (dirty) or Esc hint (clean) — the shared DialogFooter (web-rule
          217) so the task drawer reads the same as every other editable surface.
          Name/description are the only fields that stage; the immediate controls
          above never raise it. `statusText` names which fields changed. */}
      {dirty ? (
        <div className="shrink-0 motion-safe:animate-save-bar-slide">
          <DialogFooter
            onSave={onSave}
            onCancel={onCancel}
            saving={isSaving}
            statusText={statusText}
            error={saveFailed ? "Couldn't save — try again" : null}
          />
        </div>
      ) : (
        <div className="px-4 py-2 border-t border-neutral-border bg-neutral-surface-raised text-xs text-neutral-text-secondary shrink-0 hidden md:block">
          <span className="tppm-mono">Esc</span> to close
        </div>
      )}
    </>
  );
}

/**
 * Renders a tab's registered sections in priority order. When `firstOpen` is
 * true the first section is expanded; the rest start collapsed so their queries
 * fire only on expand (ADR-0050 lazy-load, preserved tab-by-tab). The Details
 * tab passes `firstOpen={false}` because its primary content (Overview) is
 * rendered curated above these secondary accordions.
 */
export function SectionList({
  sections,
  taskId,
  projectId,
  userRole,
  canEdit,
  firstOpen = true,
}: {
  sections: DrawerSectionRegistration[];
  taskId: string;
  projectId: string;
  userRole?: number | null;
  /** Effective server-derived edit capability for the task (ADR-0133); threaded
   *  to every section so write controls gate off the authoritative verdict. */
  canEdit?: boolean;
  firstOpen?: boolean;
}) {
  // The 'sprint' section is registered with a static title in the module-level
  // registry (sections/index.ts) which has no project context; resolve the
  // configurable container label here at the render boundary (ADR-0111, #862).
  const itl = useIterationLabel(projectId);
  if (sections.length === 0) {
    return (
      <div className="px-4 py-6 text-sm italic text-neutral-text-secondary">Nothing here yet.</div>
    );
  }
  return (
    <>
      {sections.map((section, idx) => {
        const SectionComponent = section.component;
        const sectionTitle = section.id === 'sprint' ? itl.singular : section.title;
        return (
          <SectionErrorBoundary key={section.id} sectionTitle={sectionTitle}>
            <CollapsibleSection
              id={section.id}
              title={sectionTitle}
              defaultOpen={firstOpen && idx === 0}
            >
              {() => (
                <SectionComponent
                  taskId={taskId}
                  projectId={projectId}
                  userRole={userRole}
                  canEdit={canEdit}
                />
              )}
            </CollapsibleSection>
          </SectionErrorBoundary>
        );
      })}
    </>
  );
}
