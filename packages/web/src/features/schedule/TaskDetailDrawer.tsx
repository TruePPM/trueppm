import { type RefObject, useEffect, useRef, useState } from 'react';
import type { EstimationMode, Task, TaskLink } from '@/types';
import { DependenciesTab } from './DependenciesTab';
import { EstimatesTab } from './EstimatesTab';
import { HistoryTab } from './HistoryTab';
import { BaselineTab } from './BaselineTab';

type TabId = 'dependencies' | 'estimates' | 'history' | 'baseline';

const TABS: { id: TabId; label: string }[] = [
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'estimates', label: 'Estimates' },
  { id: 'history', label: 'History' },
  { id: 'baseline', label: 'Baseline' },
];

export interface TaskDetailDrawerProps {
  task: Task | null;
  tasks: Task[];
  links: TaskLink[];
  projectId: string;
  estimationMode?: EstimationMode;
  userIsScheduler?: boolean;
  onClose: () => void;
}

export function TaskDetailDrawer({
  task,
  tasks,
  links,
  projectId,
  estimationMode = 'open',
  userIsScheduler = false,
  onClose,
}: TaskDetailDrawerProps) {
  const isOpen = task !== null;
  const drawerTitle = task ? `${task.wbs ? task.wbs + ' — ' : ''}${task.name}` : '';

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, task?.id]);

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
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
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
      estimationMode={estimationMode}
      userIsScheduler={userIsScheduler}
      closeButtonRef={closeButtonRef}
      drawerTitle={drawerTitle}
      onClose={onClose}
    />
  );

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop: 480px right-side slide-in */}
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

      {/* Mobile: 85vh bottom sheet */}
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
  estimationMode: EstimationMode;
  userIsScheduler: boolean;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  drawerTitle: string;
  onClose: () => void;
}

function DrawerBody({
  task,
  tasks,
  links,
  projectId,
  estimationMode,
  userIsScheduler,
  closeButtonRef,
  drawerTitle,
  onClose,
}: DrawerBodyProps) {
  const [activeTab, setActiveTab] = useState<TabId>('dependencies');

  useEffect(() => {
    setActiveTab('dependencies');
  }, [task?.id]);

  if (!task) return null;

  const hasPendingEstimate = task.estimateStatus === 'pending';
  const hasPartialEstimate =
    (task.optimisticDuration != null ||
      task.mostLikelyDuration != null ||
      task.pessimisticDuration != null) &&
    !(
      task.optimisticDuration != null &&
      task.mostLikelyDuration != null &&
      task.pessimisticDuration != null
    );
  const showEstimateBadge = hasPendingEstimate || hasPartialEstimate;

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

      {/* Tab bar — 48px tall, horizontally scrollable on mobile */}
      <div
        role="tablist"
        aria-label="Task detail sections"
        className="flex overflow-x-auto shrink-0 border-b border-neutral-border h-12 px-1"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={[
                'relative flex items-center gap-1.5 h-full shrink-0 px-3 text-sm',
                'whitespace-nowrap border-b-2 transition-colors duration-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:rounded-sm',
                isActive
                  ? 'border-brand-primary font-semibold text-neutral-text-primary'
                  : 'border-transparent font-normal text-neutral-text-secondary hover:text-neutral-text-primary',
              ].join(' ')}
            >
              {tab.label}
              {tab.id === 'estimates' && showEstimateBadge && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-brand-accent shrink-0"
                  aria-label="Estimates incomplete or pending approval"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      <div className="flex-1 overflow-y-auto p-4">
        <div
          role="tabpanel"
          id="tabpanel-dependencies"
          aria-labelledby="tab-dependencies"
          hidden={activeTab !== 'dependencies'}
        >
          {activeTab === 'dependencies' && (
            <DependenciesTab
              task={task}
              tasks={tasks}
              links={links}
              projectId={projectId}
            />
          )}
        </div>

        <div
          role="tabpanel"
          id="tabpanel-estimates"
          aria-labelledby="tab-estimates"
          hidden={activeTab !== 'estimates'}
        >
          {activeTab === 'estimates' && (
            <EstimatesTab
              task={task}
              projectId={projectId}
              estimationMode={estimationMode}
              userIsScheduler={userIsScheduler}
            />
          )}
        </div>

        <div
          role="tabpanel"
          id="tabpanel-history"
          aria-labelledby="tab-history"
          hidden={activeTab !== 'history'}
        >
          {activeTab === 'history' && (
            <HistoryTab projectId={projectId} taskId={task.id} />
          )}
        </div>

        <div
          role="tabpanel"
          id="tabpanel-baseline"
          aria-labelledby="tab-baseline"
          hidden={activeTab !== 'baseline'}
        >
          {activeTab === 'baseline' && (
            <BaselineTab projectId={projectId} taskId={task.id} />
          )}
        </div>
      </div>
    </>
  );
}
