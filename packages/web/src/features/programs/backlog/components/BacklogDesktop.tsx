/**
 * Desktop two-pane layout (≥ md). List left, detail/edit pane right; ratio
 * 1.3fr/1fr at md, 1.6fr/1fr at lg (01-page-layout). Renders the full-page
 * empty state when the program has no items. Owns the page-wide keyboard
 * shortcuts (`/` focuses search, `P` opens the pull flow for the selection)
 * and the two aria-live regions the controller writes into.
 */

import { useEffect, useRef } from 'react';
import type { BacklogController } from '../hooks/useBacklogController';
import { BacklogHeader } from './BacklogHeader';
import { BacklogList } from './BacklogList';
import { BacklogToasts } from './BacklogToasts';
import { BacklogToolbar } from './BacklogToolbar';
import { DetailPane } from './DetailPane';
import { EmptyBacklog } from './EmptyBacklog';

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable
  );
}

interface BacklogDesktopProps {
  controller: BacklogController;
}

export function BacklogDesktop({ controller }: BacklogDesktopProps) {
  const { url, allItems, selectedItem, canEdit, isLoading } = controller;
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !isTypingInInput()) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (
        (e.key === 'p' || e.key === 'P') &&
        !isTypingInInput() &&
        canEdit &&
        selectedItem?.status === 'PROPOSED'
      ) {
        e.preventDefault();
        url.openPull(selectedItem.id);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [url, selectedItem, canEdit]);

  const isEmpty = !isLoading && allItems.length === 0;

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      <BacklogHeader
        programName={controller.programName}
        program={controller.program}
        canEdit={canEdit}
        onCreate={url.openCreate}
      />

      {isEmpty ? (
        <EmptyBacklog canEdit={canEdit} onCreate={url.openCreate} />
      ) : (
        <>
          <BacklogToolbar controller={controller} searchInputRef={searchInputRef} />
          <div className="grid min-h-0 flex-1 grid-cols-[1.3fr_1fr] lg:grid-cols-[1.6fr_1fr]">
            <div className="min-h-0 border-r border-neutral-border">
              <BacklogList controller={controller} />
            </div>
            <div className="min-h-0">
              <DetailPane controller={controller} />
            </div>
          </div>
        </>
      )}

      <BacklogToasts controller={controller} />

      {/* Screen-reader status channels (07-context aria-live contract). */}
      <p aria-live="polite" className="sr-only">
        {controller.liveMessage}
      </p>
      <p aria-live="assertive" className="sr-only">
        {controller.alertMessage}
      </p>
    </div>
  );
}
