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
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditTask } from '@/lib/roles';
import { ReadinessChip } from '../board/ReadinessChip';
import { CollapsibleSection } from './sections/CollapsibleSection';
import { SectionErrorBoundary } from './sections/SectionErrorBoundary';
import { TaskScheduleStrip } from './TaskScheduleStrip';
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
 * Edit model (#962, VoC-tuned "B-lite"): every section autosaves immediately as
 * before; only the free-text Description stages behind a Settings-style save
 * bar, and even that flushes on blur, tab-switch, and close so an edit is never
 * silently stranded.
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
  const { mutate: updateTask, isPending: isSaving } = useUpdateTask();
  // 1046: thread the viewer's project role into the sections so write controls
  // (add link, add attachment, edit description) are hidden from Viewers instead
  // of surfacing affordances that 403 on submit. `role` is null while it loads.
  const { role: userRole } = useCurrentUserRole(projectId);

  // Deferred-edit form (Description + name). State lives here, not in the inner
  // content, so Esc / close / tab-switch can flush before tearing down — and so
  // the desktop and mobile shells stay in sync.
  const [activeTab, setActiveTab] = useState<DrawerSectionTab>('details');
  const [nameDraft, setNameDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');

  // Reset drafts + tab when the *identity* of the rendered task changes (the
  // user opened a different task). A server-side update to the same task does
  // not reset — that would clobber an in-progress edit.
  const taskId = task?.id;
  useEffect(() => {
    if (task) {
      setNameDraft(task.name);
      setNotesDraft(task.notes ?? '');
      setActiveTab('details');
    }
    // Only react to identity changes, not to every field mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const dirty = task !== null && (nameDraft !== task.name || notesDraft !== (task.notes ?? ''));

  // Last server value we synced the drafts from — used to detect a concurrent
  // edit (another collaborator's WebSocket update) while the user has unsaved
  // changes. Re-syncs whenever the form is clean.
  const syncedNotesRef = useRef('');
  useEffect(() => {
    if (task && !dirty) syncedNotesRef.current = task.notes ?? '';
  }, [task, dirty]);
  const notesChangedElsewhere =
    task !== null &&
    dirty &&
    (task.notes ?? '') !== syncedNotesRef.current &&
    (task.notes ?? '') !== notesDraft;

  const flush = useCallback(() => {
    if (!task || !dirty) return;
    updateTask({
      id: task.id,
      projectId,
      ...(nameDraft !== task.name ? { name: nameDraft } : {}),
      ...(notesDraft !== (task.notes ?? '') ? { notes: notesDraft } : {}),
    });
  }, [task, projectId, dirty, nameDraft, notesDraft, updateTask]);

  const discard = useCallback(() => {
    if (task) {
      setNameDraft(task.name);
      setNotesDraft(task.notes ?? '');
    }
  }, [task]);

  // Closing flushes any pending edit so a half-typed description survives.
  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  // Expand → the full-page focus view of this task (ADR-0124 / handoff #13).
  // Flush the deferred edit first, navigate, then close the drawer.
  const navigate = useNavigate();
  const handleExpand = useCallback(() => {
    if (!task) return;
    flush();
    void navigate(`/projects/${projectId}/tasks/${task.id}`);
    onClose();
  }, [task, projectId, flush, navigate, onClose]);

  const changeTab = useCallback(
    (next: DrawerSectionTab) => {
      flush();
      setActiveTab(next);
    },
    [flush],
  );

  // Move focus to Close on open so keyboard users land somewhere sensible.
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, taskId]);

  // Esc closes (flushing first) — preserved from prior drawer.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        handleClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // Focus trap inside drawer when open — preserved from prior drawer.
  useEffect(() => {
    if (!isOpen) return undefined;
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
  }, [isOpen]);

  // Read sections from the registry once per render. The registry sorts by
  // priority on register() so no sort here. Filter by canRender so Enterprise
  // sections that gate on license disappear cleanly.
  const sections = useMemo(() => {
    if (!task) return [];
    const ctx = { user: sectionContext?.user, task };
    return (registry.get('task_detail.section') as DrawerSectionRegistration[]).filter(
      (s) => !s.canRender || s.canRender(ctx),
    );
  }, [task, sectionContext?.user]);

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
      onClose={handleClose}
      onExpand={handleExpand}
      tabs={visibleTabs}
      activeTab={activeTab}
      onTabChange={changeTab}
      sectionsByTab={sectionsByTab}
      subtaskStats={subtaskStats}
      nameDraft={nameDraft}
      onNameChange={setNameDraft}
      notesDraft={notesDraft}
      onNotesChange={setNotesDraft}
      notesChangedElsewhere={notesChangedElsewhere}
      dirty={dirty}
      isSaving={isSaving}
      onFlush={flush}
      onSave={flush}
      onDiscard={discard}
    />
  );

  return (
    <>
      {/* Mobile backdrop — closes on click; desktop has no backdrop (drawer is non-modal-feeling) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={handleClose}
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
          'transition-transform duration-slow ease-brand',
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
          'transition-transform duration-200',
          isOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        <div
          className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0"
          aria-hidden="true"
        />
        {content}
      </div>
    </>
  );
}

interface DrawerContentProps {
  task: Task;
  projectId: string;
  userRole?: number | null;
  drawerTitle: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onExpand: () => void;
  tabs: ReadonlyArray<{ id: DrawerSectionTab; label: string }>;
  activeTab: DrawerSectionTab;
  onTabChange: (tab: DrawerSectionTab) => void;
  sectionsByTab: Record<DrawerSectionTab, DrawerSectionRegistration[]>;
  subtaskStats: { total: number; done: number };
  nameDraft: string;
  onNameChange: (value: string) => void;
  notesDraft: string;
  onNotesChange: (value: string) => void;
  notesChangedElsewhere: boolean;
  dirty: boolean;
  isSaving: boolean;
  onFlush: () => void;
  onSave: () => void;
  onDiscard: () => void;
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
  onClose,
  onExpand,
  tabs,
  activeTab,
  onTabChange,
  sectionsByTab,
  subtaskStats,
  nameDraft,
  onNameChange,
  notesDraft,
  onNotesChange,
  notesChangedElsewhere,
  dirty,
  isSaving,
  onFlush,
  onSave,
  onDiscard,
}: DrawerContentProps) {
  // WAI-ARIA tab pattern (#1022): ArrowLeft/Right move selection+focus across
  // the tablist so a keyboard user reaches a sibling tab without Tab-cycling
  // through the active panel's content. Focus follows selection (automatic
  // activation) since switching tabs is cheap here.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
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
            onClick={onClose}
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
        <input
          aria-label="Task name"
          value={nameDraft}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={onFlush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          // ADR-0133/1142: the title is read-only for non-editors. A readOnly
          // input renders as plain text (bg-transparent, no border) and drops the
          // edit focus ring + caret so it never invites an edit that would 403.
          readOnly={!canEdit}
          className={[
            'w-full bg-transparent border-none outline-none px-0 mb-2',
            'text-xl font-semibold tracking-tight text-neutral-text-primary rounded-control',
            canEdit
              ? 'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1'
              : 'cursor-default focus:outline-none',
          ].join(' ')}
        />

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
                  <DescriptionField
                    value={notesDraft}
                    onChange={onNotesChange}
                    onBlur={onFlush}
                    changedElsewhere={notesChangedElsewhere}
                    readOnly={!canEdit}
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

      {/* Save bar (dirty) or Esc hint (clean) — mirrors the Settings save contract */}
      {dirty ? (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-brand-primary border-t border-brand-primary-dark motion-safe:animate-save-bar-slide">
          <span className="text-[13px] font-medium text-white" role="status">
            You have unsaved changes
          </span>
          <div className="flex-1" />
          {/* preventDefault on mousedown keeps focus on the Description textarea
              so its onBlur={onFlush} does NOT fire when a save-bar button is the
              click target. Without this, clicking Discard blurs the textarea
              first, flush() optimistically persists the edit, and the subsequent
              discard() reverts the draft to a now-stale value — leaving the form
              dirty and the edit silently saved (#972). It also prevents a
              redundant double-PATCH on Save (blur-flush + click-flush). */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDiscard}
            disabled={isSaving}
            className="text-[13px] text-white/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
          >
            Discard
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSave}
            disabled={isSaving}
            className="px-3.5 py-1.5 rounded-control bg-white text-brand-primary-dark text-[13px] font-semibold hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : 'Save changes'}
          </button>
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
 * Deferred-save Description field (#962). The one free-text field that stages
 * edits behind the drawer's save bar; it flushes on blur (and on tab-switch /
 * close via the parent), so the save bar acts as a safety net rather than a
 * gate (VoC-tuned B-lite). A concurrent-edit notice warns before an unsaved
 * edit would overwrite a collaborator's change.
 */
function DescriptionField({
  value,
  onChange,
  onBlur,
  changedElsewhere,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  changedElsewhere: boolean;
  /** 1046: Viewers see the description read-only rather than an editable field
   *  whose PATCH 403s on blur. */
  readOnly?: boolean;
}) {
  return (
    <div>
      <div className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Description
      </div>
      <textarea
        aria-label="Description"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        rows={3}
        readOnly={readOnly}
        placeholder={readOnly ? 'No description' : 'Add a description…'}
        className={[
          'w-full rounded-control border border-neutral-border px-3 py-2.5',
          'text-sm leading-relaxed text-neutral-text-primary placeholder:text-neutral-text-disabled',
          'resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          readOnly ? 'bg-neutral-surface-sunken cursor-default' : 'bg-neutral-surface',
        ].join(' ')}
      />
      {!readOnly && changedElsewhere && (
        <p role="status" className="mt-1.5 text-xs text-semantic-at-risk">
          Updated by someone else since you started editing — saving will overwrite their change.
        </p>
      )}
    </div>
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
