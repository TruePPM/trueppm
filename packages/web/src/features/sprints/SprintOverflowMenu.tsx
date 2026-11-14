import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { useSprintMutations } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { ApiSprint } from '@/types';

interface Props {
  sprint: ApiSprint;
  projectId: string;
  /**
   * SCHEDULER+ may toggle (server enforces the same field-level gate, ADR-0113).
   * Lower roles still see the item with its state and who owns it — never
   * hidden, so an excluded sprint never looks broken (VoC Priya).
   */
  canEdit: boolean;
}

/**
 * Sprint overflow ("⋯") menu — home of the per-sprint settings that are not
 * part of the sprint's daily lifecycle chrome. Today that is one item, the
 * ADR-0113 "Exclude from velocity" escape hatch that holds a setup/ramp-up
 * "Sprint 0" out of the velocity average and the milestone forecast.
 *
 * It was a full-width card in the page body (#3610); a rarely-used switch does
 * not earn standing page real estate. The excluded STATE still has a standing
 * signal — `SprintHeader` renders an "Excluded from velocity" chip whenever it
 * is on — so moving the control never hides the fact.
 *
 * Editable in every sprint state including COMPLETED (teams realize the
 * contamination in hindsight). Plain language only (no "velocity sampling" /
 * "Monte Carlo" jargon).
 */
export function SprintOverflowMenu({ sprint, projectId, canEdit }: Props) {
  const itl = useIterationLabel();
  const { updateSprint } = useSprintMutations(projectId);
  const [open, setOpen] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const on = sprint.exclude_from_velocity ?? false;
  const pending = updateSprint.isPending;

  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: 288,
    estimatedHeight: 140,
    align: 'right',
    onDismiss: () => setOpen(false),
  });

  // The item is the menu's only stop: seat focus on it as the panel mounts.
  const seated = popoverStyle !== null;
  useEffect(() => {
    if (open && seated) itemRef.current?.focus();
  }, [open, seated]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const toggle = () => {
    if (!canEdit || pending) return;
    updateSprint.mutate({ sprintId: sprint.id, payload: { exclude_from_velocity: !on } });
    close();
  };

  const onMenuKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // A menu is not a tab stop sequence; leaving it closes it.
      setOpen(false);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); // single item: arrows keep focus on it
      itemRef.current?.focus();
    }
  };

  const itemLabel = on
    ? `${sprint.name} is excluded from velocity`
    : `Exclude ${sprint.name} from velocity`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${itl.singular} options`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded border border-neutral-border
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        <span aria-hidden="true" className="text-base leading-none">
          ⋯
        </span>
      </button>
      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            id={menuId}
            role="menu"
            aria-label={`${itl.singular} options`}
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
            className="z-30 overflow-y-auto rounded-card border border-neutral-border bg-neutral-surface py-1"
          >
            <div
              ref={itemRef}
              role="menuitemcheckbox"
              aria-checked={on}
              aria-disabled={!canEdit || pending || undefined}
              aria-label={itemLabel}
              aria-describedby={`${menuId}-desc`}
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              }}
              className="flex min-h-[44px] cursor-pointer flex-col gap-0.5 px-3 py-2 hover:bg-neutral-surface-sunken
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
            >
              <span aria-hidden="true" className="flex items-center gap-2 text-sm font-medium text-neutral-text-primary">
                <span
                  className={[
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-xs leading-none',
                    on
                      ? 'border-brand-primary bg-brand-primary text-white dark:text-navy-900'
                      : 'border-neutral-border',
                  ].join(' ')}
                >
                  {on ? '✓' : ''}
                </span>
                Exclude from velocity
              </span>
              <span id={`${menuId}-desc`} className="text-xs text-neutral-text-secondary">
                Keeps this {itl.lower} out of your velocity average and delivery forecast. Use it for a
                setup or ramp-up {itl.lower} (a “{itl.singular} 0”) whose low throughput would
                otherwise drag the numbers down — the {itl.lower} still appears in your history.
              </span>
              {!canEdit && (
                <span className="text-xs text-neutral-text-secondary">
                  {on ? 'Excluded' : 'Not excluded'} — managed by a Scheduler or above.
                </span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
