/**
 * Tombstone for a label a saved view still references but the project no longer
 * has (#2394, frame D2). The counterpart to {@link LabelChip}.
 *
 * **Why it says "Deleted label" and not the label's name.** It cannot know the
 * name. The catalog endpoint filters `is_deleted=False`, so a deleted label is
 * simply absent — there is no client-reachable name to print. That is also the
 * property that keeps this from becoming a cross-project label-name oracle
 * (#2385's security gate): a saved view may carry a label id owned by *another*
 * project, and it renders exactly this same anonymous tombstone rather than
 * resolving a name from anywhere wider than the current project's catalog.
 *
 * The deleted state is carried by **shape** (hatched swatch), **typography**
 * (strikethrough), and **words** ("deleted") — never by color alone, so it
 * survives a monochrome or high-contrast rendering (rule 6).
 */
import { labelDotStyle } from '@/lib/labelColors';

interface DeletedLabelChipProps {
  /** Rendered only as a stable React key / test hook — never displayed. */
  id: string;
  /** `menu` is the dense variant used in the saved-views list. */
  variant?: 'strip' | 'menu';
}

export function DeletedLabelChip({ id, variant = 'strip' }: DeletedLabelChipProps) {
  const dense = variant === 'menu';
  return (
    <span
      data-testid={`deleted-label-${id}`}
      className={[
        'inline-flex items-center gap-1 rounded-full border border-dashed',
        'border-neutral-text-secondary/50 text-neutral-text-secondary',
        dense ? 'h-4 px-1.5 text-xs' : 'h-6 px-2 text-xs',
      ].join(' ')}
    >
      {/* Hatched, not filled: a solid grey dot reads as "a label that happens to
          be grey". The stripe pattern says "absent" without relying on hue. */}
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full opacity-70"
        style={{
          ...labelDotStyle(null),
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 1px, rgba(255,255,255,0.85) 1px, rgba(255,255,255,0.85) 2px)',
        }}
      />
      {/* The design of record strikes through the label's *name* and appends
          "(deleted)". With no name to strike through, both halves would say the
          same thing — "Deleted label (deleted)" — so the strikethrough carries
          the visual state and the words carry it once. */}
      <span className="line-through">Deleted label</span>
    </span>
  );
}
