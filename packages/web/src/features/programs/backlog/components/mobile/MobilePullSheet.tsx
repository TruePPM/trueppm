/**
 * Mobile pull-down — a 85vh bottom sheet (06-mobile). Same single-target radio
 * picker as desktop, taller rows for touch, full-width sticky CTA. The
 * "what will happen" detail is collapsed behind a "Learn more" toggle to keep
 * the sheet oriented; expanding reveals the same bullets as desktop.
 */

import { useEffect, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { CloseIcon } from '@/components/Icons';
import type { BacklogItem, MemberProject } from '../../types';
import { ProjectPickerRadioList } from '../ProjectPickerRadioList';
import { BTN_PRIMARY, FOCUS_RING } from '../styles';

interface MobilePullSheetProps {
  open: boolean;
  item: BacklogItem | undefined;
  projects: MemberProject[];
  onClose: () => void;
  onConfirm: (project: MemberProject) => void;
}

const TYPE_LABEL: Record<BacklogItem['itemType'], string> = {
  story: 'Story',
  epic: 'Epic',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

export function MobilePullSheet({
  open,
  item,
  projects,
  onClose,
  onConfirm,
}: MobilePullSheetProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedId(projects[0]?.id ?? null);
      setShowDetail(false);
    }
  }, [open, projects]);

  if (!item) return null;
  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <BottomSheet isOpen={open} onClose={onClose} ariaLabel="Pull to project" size="large">
      <div className="flex h-full flex-col px-4 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between py-1">
          <h2 className="text-sm font-semibold text-neutral-text-primary">Pull to project</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel pull"
            className={`flex h-9 w-9 items-center justify-center rounded-control text-neutral-text-secondary ${FOCUS_RING}`}
          >
            <CloseIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-neutral-border pb-2">
          <div className="text-sm font-medium text-neutral-text-primary">{item.title}</div>
          <div className="tppm-mono text-xs text-neutral-text-secondary">
            {item.id} · {TYPE_LABEL[item.itemType]}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-3">
          <p className="mb-2 text-xs text-neutral-text-secondary">
            Choose a project to pull this to.
          </p>
          <ProjectPickerRadioList
            projects={projects}
            value={selectedId}
            onChange={setSelectedId}
            tall
          />
          <p className="mt-3 text-xs text-neutral-text-secondary">
            This creates a task and marks the item Pulled.{' '}
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className={`font-medium text-brand-primary ${FOCUS_RING}`}
            >
              {showDetail ? 'Less' : 'Learn more'}
            </button>
          </p>
          {showDetail && (
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-neutral-text-secondary">
              <li>• This item becomes Pulled</li>
              <li>• New task in {selected ? `${selected.name}'s` : 'the project'} backlog</li>
              <li>• Title, description, tags, owner are copied over</li>
              <li>• Closing the task closes this item</li>
            </ul>
          )}
        </div>

        <button
          type="button"
          className={`${BTN_PRIMARY} my-3 h-11 w-full`}
          disabled={!selected}
          onClick={() => {
            if (selected) {
              onConfirm(selected);
              onClose();
            }
          }}
        >
          {selected ? `Pull to ${selected.name}` : 'Pull to project'}
        </button>
      </div>
    </BottomSheet>
  );
}
