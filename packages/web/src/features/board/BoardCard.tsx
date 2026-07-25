import { memo, useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { BoardProgressRing } from './BoardProgressRing';
import { CardAcceptIcon } from './card/CardAcceptIcon';
import { CardCompactBody } from './card/CardCompactBody';
import { CardFullBody } from './card/CardFullBody';
import { CardOverflowMenu } from './card/CardOverflowMenu';
import { CardShell } from './card/CardShell';
import { useBoardCardView } from './card/useBoardCardView';
import type { BoardCardProps } from './card/types';

export type {
  BoardDensity,
  BoardCardScopeActions,
  EvmMode,
  BoardCardColumn,
  BoardCardProps,
} from './card/types';

/**
 * Pull DOM focus to this card when it becomes the keyboard-focused one.
 *
 * j/k/l/h board navigation must move *real* DOM focus, not just paint a ring
 * (#2194 — the previous model set `focusedCardId` state only, so screen readers
 * announced nothing, focus never moved, and Enter/E never reached a card).
 *
 * But `focusedCardId` is *not* keyboard-only — it is also set on pointer down
 * and focus-capture over a card (tracking) and during drag. If we blindly
 * `focus()` on every change we steal focus from whatever the user is actually
 * operating: an in-card control (chain/risk chip, ··· menu) or an unrelated
 * widget like the column resize separator. So we only pull focus when the move
 * is plausibly a keyboard hop — focus is ambient (body) or already sitting on
 * another board card — and never when focus is already inside *this* card.
 */
function useKeyboardFocusFollow(
  cardElRef: RefObject<HTMLDivElement | null>,
  pointerFocusRef: RefObject<boolean>,
  isKeyboardFocused: boolean,
  isFilteredOut: boolean,
) {
  useEffect(() => {
    if (!isKeyboardFocused || isFilteredOut) return;
    // A pointer press is driving focus natively — don't fight it (see the ref).
    if (pointerFocusRef.current) return;
    const el = cardElRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Focus already within this card (e.g. the user clicked its chain chip): leave
    // it on that control — don't yank it to the card root.
    if (el.contains(active)) return;
    // Only follow keyboard board-nav: from body (ambient) or from another card.
    const fromAmbient = active == null || active === document.body;
    const fromAnotherCard =
      active instanceof Element && active.closest('[data-board-card]') != null;
    if (!fromAmbient && !fromAnotherCard) return;
    el.focus({ preventScroll: true });
    // Optional-chained: jsdom has no layout and does not implement scrollIntoView.
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [cardElRef, pointerFocusRef, isKeyboardFocused, isFilteredOut]);
}

function BoardCardImpl(props: BoardCardProps) {
  const {
    task,
    isOverlay,
    onMenuMove,
    overallocByResource,
    isKeyboardFocused = false,
    isFilteredOut = false,
    onShowDeps,
    onShowRisks,
    onChainHover,
    onCardClick,
    scopeActions,
    readOnly = false,
    customFieldDefs,
  } = props;

  const view = useBoardCardView(props);

  // A read-only board disables drag-to-assign (closed sprint, issue 1141; or a
  // Viewer, #2146). dnd-kit clears `listeners` when disabled but its `attributes`
  // still carry `role="button"` + `aria-disabled="true"`, which makes the card
  // unoperable to keyboard/AT users (and Playwright reads it as "not enabled").
  // A read-only card is still click-to-open detail, so drop the drag attributes
  // and keep it a plain focusable button — never aria-disabled.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: readOnly,
  });

  // True while a pointer press is in flight on this card. On pointer-down the
  // browser will move DOM focus itself (to the card, or to the exact control the
  // user pressed — a chain chip, the ··· menu), and `focusedCardId` also updates
  // via the card's pointer-down / focus-capture tracking. The keyboard-focus
  // effect must NOT also `focus()` the card root during that window: at
  // pointer-down time `document.activeElement` is still `body`, so it would look
  // "ambient", and stealing focus mid-press cancels the click the user intended
  // (#2194 — clicking the chain chip opened the card instead of the deps popover).
  const pointerFocusRef = useRef(false);
  const pointerTracking = {
    onPointerDownCapture: () => {
      pointerFocusRef.current = true;
    },
    onPointerUpCapture: () => {
      pointerFocusRef.current = false;
    },
    onPointerCancelCapture: () => {
      pointerFocusRef.current = false;
    },
  };

  // `data-board-card` marks the card root so the keyboard-focus effect can tell
  // "focus is on another board card" (a legit j/k/l/h hop, follow it) from
  // "focus is on an unrelated control" (a resize separator, an in-card button —
  // don't steal it). See useKeyboardFocusFollow (#2194).
  //
  // dnd-kit's `attributes` also carry `aria-describedby` pointing at its
  // live-region instruction ("To pick up a draggable item, press space or
  // enter…"). That pickup path is dead on this board: `CardShell` overrides
  // `onKeyDown` with the open-detail handler, so the KeyboardSensor activator
  // never fires (#2194). Announcing a keyboard-drag that cannot happen is a
  // false SR instruction, so we drop only that association —
  // `aria-roledescription="draggable"` is kept: the card genuinely is
  // pointer/touch-draggable, and it is the card-root selector.
  const dragProps = readOnly
    ? { role: 'button' as const, tabIndex: 0, 'data-board-card': '', ...pointerTracking }
    : {
        ...listeners,
        ...attributes,
        'aria-describedby': undefined,
        'data-board-card': '',
        ...pointerTracking,
      };

  // Bind the task-aware chain-hover handlers to this card once per render. These
  // live inside the component (not in the parent's map) so the card's incoming
  // props stay a single stable reference and React.memo can skip it (issue 1520).
  const handleChainHoverEnter = () => onChainHover?.(task.id);
  const handleChainHoverLeave = () => onChainHover?.(null);

  // Remember the real card's rendered height so the drag placeholder matches
  // it (rule 102: placeholder of equal height).  Updated on every non-drag
  // render so varying card content — CP pill, assignees, entry stamp, nudge —
  // produces an equal-height slot.
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const lastHeightRef = useRef<number>(0);
  const measureCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardElRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useLayoutEffect(() => {
    if (isDragging) return;
    const h = cardElRef.current?.offsetHeight;
    if (h && h > 0) lastHeightRef.current = h;
  });

  useKeyboardFocusFollow(cardElRef, pointerFocusRef, isKeyboardFocused, isFilteredOut);

  // Overlay card — the floating drag copy (rule 102)
  if (isOverlay) {
    return (
      <div
        className="bg-neutral-surface border border-neutral-border rounded-card p-3
          ring-2 ring-brand-primary opacity-60 scale-105 motion-safe:rotate-1
          w-[85vw] md:w-auto md:min-w-[200px]"
      >
        <div className="flex items-center gap-1.5">
          <BoardProgressRing
            progress={view.effectiveProgress}
            isCritical={view.showCriticalState}
            isStalled={view.isStalled}
          />
          <p className="text-sm font-medium text-neutral-text-primary truncate">{task.name}</p>
        </div>
      </div>
    );
  }

  // Placeholder slot when this card is being dragged (rule 102) — height
  // matches the source card so surrounding cards don't jump during drag.
  if (isDragging) {
    return (
      <div
        className="border-2 border-dashed border-neutral-border rounded-card"
        style={{ height: lastHeightRef.current || 76 }}
      />
    );
  }

  const chainHover = {
    onChainHoverEnter: handleChainHoverEnter,
    onChainHoverLeave: handleChainHoverLeave,
  };

  return (
    <CardShell
      task={task}
      cardRef={measureCardRef}
      dragProps={dragProps}
      containerClass={view.containerClass}
      showCriticalState={view.showCriticalState}
      effectiveProgress={view.effectiveProgress}
      columnLabel={view.columnLabel}
      isFilteredOut={isFilteredOut}
      stopKeyPropagation={view.isCompact}
      onCardClick={onCardClick}
    >
      {view.isCompact ? (
        <CardCompactBody
          task={task}
          view={view}
          customFieldDefs={customFieldDefs}
          onShowDeps={onShowDeps}
          onShowRisks={onShowRisks}
          {...chainHover}
        />
      ) : (
        <CardFullBody
          task={task}
          view={view}
          customFieldDefs={customFieldDefs}
          overallocByResource={overallocByResource}
          onShowDeps={onShowDeps}
          onShowRisks={onShowRisks}
          {...chainHover}
        />
      )}
      {/* A pending card shows the single-tap ✓ accept in the right-9 slot. The
          dependency/risk signal chips live in-flow in the badge row (issue
          1735), so the top-right corner holds only the accept ✓ and the ··· menu. */}
      <CardAcceptIcon
        task={task}
        isPending={view.isPending}
        scopeActions={scopeActions}
        iterationLabel={view.itl.lower}
      />
      <CardOverflowMenu
        task={task}
        otherColumns={view.otherColumns}
        onMenuMove={onMenuMove}
        isPending={view.isPending}
        scopeActions={scopeActions}
        iterationLabel={view.itl.lower}
      />
    </CardShell>
  );
}

/**
 * Memoized so an unrelated board re-render (drag-over, another card's focus,
 * chain-hover, a search keystroke) skips every card whose props are unchanged
 * (issue 1520). The default shallow prop comparison is correct here because the
 * parent now feeds only primitives (`isKeyboardFocused`, `isDimmed`), the stable
 * `task` reference, and stable task-aware callbacks — no per-card closures.
 */
export const BoardCard = memo(BoardCardImpl);
