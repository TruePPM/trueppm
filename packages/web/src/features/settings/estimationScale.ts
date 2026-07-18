import type { InheritableSelectOption } from './components/InheritableSelectField';
import type { EstimationScale } from '@/api/types';

/**
 * Estimation-scale options (ADR-0510, #2027). Shared across the Workspace, Program,
 * and Project settings pages so the labels never fork. `fibonacci` reproduces the
 * previous de-facto scale (the only hardcoded picker used Fibonacci).
 */
export const ESTIMATION_SCALE_OPTIONS: ReadonlyArray<InheritableSelectOption<EstimationScale>> = [
  { value: 'fibonacci', label: 'Fibonacci (1, 2, 3, 5, 8, 13, 21)' },
  { value: 'linear', label: 'Linear (1-10)' },
  { value: 'tshirt', label: 'T-shirt (XS, S, M, L, XL)' },
];

/** Help text shared by the estimation-scale control on all three scopes. */
export const ESTIMATION_SCALE_HINT =
  'The scale your team estimates backlog items in. T-shirt sizes map to points behind the scenes, so velocity and rollups are unaffected.';
