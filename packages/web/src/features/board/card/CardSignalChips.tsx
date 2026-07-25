import type { Task } from '@/types';
import { LinkIcon, WarningIcon } from '@/components/Icons';
import { severityRagBand } from '@/hooks/useTaskDependencies';
import { riskChipToneClass } from './cardFormat';

// `before:inset-[-12px]` restores the ≥44px touch target (rule 5) the emoji
// buttons had — the chip itself is ~20px, so the invisible pseudo pad carries
// the hit area (mirrors the ··· menu / accept ✓ / worst-offender badge).
const CHIP_BASE = [
  'relative shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded-chip text-xs border font-medium',
  "before:absolute before:inset-[-12px] before:content-['']",
  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
].join(' ');

interface CardSignalChipsProps {
  task: Task;
  showChain: boolean;
  showRisk: boolean;
  isBlocked: boolean;
  predecessorCount: number;
  linkedRisksCount: number;
  linkedRisksMaxSeverity: number | null;
  onShowDeps?: (task: Task) => void;
  onShowRisks?: (task: Task) => void;
  onChainHoverEnter: () => void;
  onChainHoverLeave: () => void;
}

/**
 * Signal chips (dependency / linked-risk) rendered INLINE in the badge/title
 * flow as shrink-0 chips (issue 1735, design §01). Previously an
 * absolute-positioned cluster at `right-9` that overwrote the truncating title
 * and collided with the ··· menu; now the title is `flex-1 min-w-0` and these
 * are `shrink-0`, so truncation happens before the icons at any density. The
 * SVG LinkIcon / WarningIcon inherit currentColor, so the blocked-red tint
 * applies to the glyph, and the count renders beside the icon as one chip.
 * They stay interactive: the chain chip opens the dependency popover + drives
 * board dep-highlight hover; the risk chip opens the risk popover.
 */
export function CardSignalChips({
  task,
  showChain,
  showRisk,
  isBlocked,
  predecessorCount,
  linkedRisksCount,
  linkedRisksMaxSeverity,
  onShowDeps,
  onShowRisks,
  onChainHoverEnter,
  onChainHoverLeave,
}: CardSignalChipsProps) {
  if (!showChain && !showRisk) return null;
  const depWord = predecessorCount === 1 ? 'dependency' : 'dependencies';
  return (
    <>
      {showChain && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShowDeps?.(task);
          }}
          onPointerEnter={onChainHoverEnter}
          onPointerLeave={onChainHoverLeave}
          onFocus={onChainHoverEnter}
          onBlur={onChainHoverLeave}
          className={[
            CHIP_BASE,
            isBlocked
              ? 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical'
              : 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary',
          ].join(' ')}
          aria-label={
            isBlocked
              ? `Blocked by ${predecessorCount} ${depWord}. Press D to view.`
              : `${predecessorCount} ${depWord}. Press D to view.`
          }
        >
          <LinkIcon className="h-3 w-3" aria-hidden="true" />
          <span className="tppm-mono leading-none">{predecessorCount}</span>
        </button>
      )}
      {showRisk && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShowRisks?.(task);
          }}
          className={[CHIP_BASE, riskChipToneClass(linkedRisksMaxSeverity)].join(' ')}
          aria-label={
            `${linkedRisksCount} linked risk${linkedRisksCount === 1 ? '' : 's'}, ` +
            `severity ${severityRagBand(linkedRisksMaxSeverity) ?? 'low'}. Click to view.`
          }
        >
          <WarningIcon className="h-3 w-3" aria-hidden="true" />
          <span className="tppm-mono leading-none">{linkedRisksCount}</span>
        </button>
      )}
    </>
  );
}
