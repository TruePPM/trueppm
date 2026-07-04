/**
 * Mobile grooming card (issue 1044) — a card, not a squeezed desktop row.
 *
 * Tapping the card opens the story drawer; tapping the DoR chip toggles
 * ready ⇄ refine (the accessible, discoverable alternative to the swipe gesture
 * — a gesture must never be the only path to an action). Swiping the card past a
 * threshold performs the same toggle, with a colored reveal behind the moving
 * card. The server owns the readiness gate, so a toggle that fails the gate is
 * simply reconciled on the next refetch (matching the desktop row toggle).
 *
 * Reuses the desktop atoms (TypeBadge, DorChip, AcMeter, AssigneeAvatar,
 * SprintCommitmentChip) so the card reads identically to the table row.
 */

import { useRef, useState, type PointerEvent } from 'react';
import type { Task } from '@/types';
import { AcMeter, AssigneeAvatar, DorChip, SprintCommitmentChip } from '../atoms';
import { TypeBadge } from '../TypeBadge';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/** Horizontal travel past which a pointer gesture counts as a swipe (commits the toggle). */
const SWIPE_COMMIT_PX = 72;
/** Travel past which a gesture is a swipe, not a tap — suppresses the open-drawer click. */
const TAP_SLOP_PX = 8;
const MAX_TRAVEL_PX = 96;

interface MobileGroomingCardProps {
  story: Task;
  onOpen: () => void;
  onToggleDor: () => void;
}

export function MobileGroomingCard({ story, onOpen, onToggleDor }: MobileGroomingCardProps) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const moved = useRef(false);
  const overSized = (story.storyPoints ?? 0) >= 8;

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    startX.current = e.clientX;
    moved.current = false;
    // Deliberately do NOT capture the pointer here: capturing on pointerdown steals
    // taps from the nested DoR-chip button (the tap's click never fires). Capture is
    // deferred to the first move past the tap slop, so a tap stays a tap.
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (startX.current === null) return;
    const delta = e.clientX - startX.current;
    if (!moved.current && Math.abs(delta) > TAP_SLOP_PX) {
      moved.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is a progressive enhancement for reliable tracking; if the
        // browser refuses it (e.g. the pointer already ended) the swipe still works.
      }
    }
    if (moved.current) setDx(Math.max(-MAX_TRAVEL_PX, Math.min(MAX_TRAVEL_PX, delta)));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (startX.current === null) return;
    const delta = e.clientX - startX.current;
    startX.current = null;
    setDx(0);
    if (Math.abs(delta) >= SWIPE_COMMIT_PX) onToggleDor();
  }

  function handleClick() {
    // A swipe already moved the pointer past the tap slop — don't also open the drawer.
    if (moved.current) {
      moved.current = false;
      return;
    }
    onOpen();
  }

  const revealTone =
    dx > TAP_SLOP_PX
      ? 'bg-semantic-on-track-bg'
      : dx < -TAP_SLOP_PX
        ? 'bg-semantic-warning-bg'
        : 'bg-transparent';

  return (
    <div className={`relative overflow-hidden rounded-card ${revealTone}`}>
      {/* Swipe reveal — decorative; the chip carries the accessible action. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-between px-4">
        <span
          className={`text-xs font-semibold text-semantic-on-track ${dx > TAP_SLOP_PX ? '' : 'opacity-0'}`}
        >
          → Ready
        </span>
        <span
          className={`text-xs font-semibold text-semantic-warning ${dx < -TAP_SLOP_PX ? '' : 'opacity-0'}`}
        >
          Refine ←
        </span>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label={`Open story ${story.name}`}
        data-testid="grooming-card"
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          startX.current = null;
          setDx(0);
        }}
        style={{ transform: `translateX(${dx}px)`, touchAction: 'pan-y' }}
        className={`flex flex-col gap-1.5 border border-neutral-border bg-neutral-surface px-3.5 py-3 ${
          dx === 0 ? 'motion-safe:transition-transform' : ''
        } rounded-card ${FOCUS_RING}`}
      >
        {/* Row 1: id · type … avatar · points */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-neutral-text-secondary">{story.shortId}</span>
          <TypeBadge type={story.taskType} />
          <span className="flex-1" />
          <AssigneeAvatar assignees={story.assignees} />
          <span
            className={`font-mono text-xs font-semibold ${
              overSized ? 'text-semantic-at-risk' : 'text-neutral-text-primary'
            }`}
          >
            {story.storyPoints ?? '—'} pts
          </span>
        </div>

        {/* Row 2: title */}
        <div className="line-clamp-2 text-sm font-medium leading-snug text-neutral-text-primary">
          {story.name}
        </div>

        {/* Row 3: DoR toggle · AC meter … sprint chip */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleDor();
            }}
            aria-label={`Toggle readiness for ${story.name}`}
            className={`-my-1 flex min-h-[36px] items-center rounded-control ${FOCUS_RING}`}
          >
            <DorChip dor={story.dor ?? 'idea'} />
          </button>
          <AcMeter met={story.acMet ?? 0} total={story.acTotal ?? 0} />
          <span className="flex-1" />
          <SprintCommitmentChip story={story} />
        </div>
      </div>
    </div>
  );
}
