import { LogoMark } from '@/components/Icons';

/**
 * TruePPM logo lockup (brand v1.0, ADR-0102): the duotone dependency-arrow mark
 * + the two-color wordmark. Per the brand wordmark spec, "True" is navy ink
 * (reversing to pale on dark) and "PPM" is Truth Sage, set solid with no space,
 * in Space Grotesk Bold at -0.02em tracking.
 */
export function Logo() {
  return (
    <span className="flex items-center gap-2 select-none" aria-label="TruePPM">
      <LogoMark size={22} className="flex-shrink-0" />
      <span className="font-display text-base font-bold tracking-[-0.02em] leading-none">
        <span className="text-navy-700 dark:text-reversed">True</span>
        <span className="text-sage-500">PPM</span>
      </span>
    </span>
  );
}
