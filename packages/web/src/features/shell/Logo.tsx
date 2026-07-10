import { LogoMark } from '@/components/Icons';

export interface LogoProps {
  /**
   * Render the two-color "TruePPM" wordmark beside the mark. Default true.
   * Set false for tight chrome (the mobile TopBar, #1788) where the full lockup
   * (~95px) crowds a phone bar that can't compress its pinned right cluster
   * (rule 174) and pushes the sync badge / bell / user menu off the right edge.
   * The mark alone still carries brand identity, the `aria-label` still names it
   * "TruePPM", and the full wordmark stays in the left rail / rail drawer.
   */
  showWordmark?: boolean;
}

/**
 * TruePPM logo lockup (brand v1.0, ADR-0103): the duotone dependency-arrow mark
 * + the two-color wordmark. Per the brand wordmark spec, "True" is navy ink
 * (reversing to pale on dark) and "PPM" is brand sage, set solid with no space,
 * in Space Grotesk Bold at -0.02em tracking. The sage is `text-brand-primary`
 * (sage-700 #316F57 on light = 5.93:1, sage-400 on dark) — the AA foreground
 * sage per rule 143, not the fills-only sage-500 which is only 2.88:1 as text
 * on white (#1689). The LogoMark's arrowhead stays sage-500 (a fill, not text).
 * The accessible name lives on the lockup's `aria-label` (rule 142), so it holds
 * even when the visible wordmark is suppressed.
 */
export function Logo({ showWordmark = true }: LogoProps = {}) {
  return (
    <span className="flex items-center gap-2 select-none" aria-label="TruePPM">
      <LogoMark size={22} className="flex-shrink-0" />
      {showWordmark && (
        <span className="font-display text-base font-bold tracking-[-0.02em] leading-none">
          <span className="text-navy-700 dark:text-reversed">True</span>
          <span className="text-brand-primary">PPM</span>
        </span>
      )}
    </span>
  );
}
