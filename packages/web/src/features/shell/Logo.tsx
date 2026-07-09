import { LogoMark } from '@/components/Icons';

/**
 * TruePPM logo lockup (brand v1.0, ADR-0103): the duotone dependency-arrow mark
 * + the two-color wordmark. Per the brand wordmark spec, "True" is navy ink
 * (reversing to pale on dark) and "PPM" is brand sage, set solid with no space,
 * in Space Grotesk Bold at -0.02em tracking. The sage is `text-brand-primary`
 * (sage-700 #316F57 on light = 5.93:1, sage-400 on dark) — the AA foreground
 * sage per rule 143, not the fills-only sage-500 which is only 2.88:1 as text
 * on white (#1689). The LogoMark's arrowhead stays sage-500 (a fill, not text).
 */
export function Logo() {
  return (
    <span className="flex items-center gap-2 select-none" aria-label="TruePPM">
      <LogoMark size={22} className="flex-shrink-0" />
      <span className="font-display text-base font-bold tracking-[-0.02em] leading-none">
        <span className="text-navy-700 dark:text-reversed">True</span>
        <span className="text-brand-primary">PPM</span>
      </span>
    </span>
  );
}
