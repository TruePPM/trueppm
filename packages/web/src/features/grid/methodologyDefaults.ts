import type { Methodology } from '@/types';
import type { GridMode } from './persistence';

/**
 * Default Grid display mode by project methodology preset (ADR-0053).
 *
 * - WATERFALL → outline (planning hierarchy is the working surface)
 * - AGILE → flat (sprint-scoped flat list, no WBS)
 * - HYBRID → outline (default to richer surface; user can switch to flat)
 *
 * Precedence in GridView: persisted-mode > methodology-default > 'outline'.
 */
export function methodologyDefaultMode(methodology: Methodology): GridMode {
  switch (methodology) {
    case 'AGILE':
      return 'flat';
    case 'WATERFALL':
    case 'HYBRID':
    default:
      return 'outline';
  }
}
