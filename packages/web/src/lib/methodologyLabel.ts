import type { Methodology } from '@/types';

/**
 * The display label for a project methodology (web-rule 196: always the resolved
 * `effective_methodology`, never a raw per-project override, at the call site).
 *
 * Centralized here because three shell surfaces render it — the Customize-views
 * menu's "Reset to {Method} default", the location-switcher project-picker
 * subtitle, and the rail "This project" card subtitle (issue #1680) — and a shared
 * label keeps them from drifting.
 */
const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

export function methodologyLabel(methodology: Methodology): string {
  return METHOD_LABEL[methodology];
}
