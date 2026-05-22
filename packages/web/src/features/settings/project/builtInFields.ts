/**
 * Static catalog of built-in task fields shown above the dynamic custom-field
 * list on the Project Settings → Workflow page (#521).
 *
 * These fields are derived from existing Task columns (or computed values).
 * They are not modeled in the DB and are not configurable — the catalog lives
 * client-side so the Workflow page can render a unified "Fields" section
 * without an extra round-trip and without a drift hazard between the DB and
 * the runtime field list.
 */

export interface BuiltInField {
  /** Stable identifier — used as the React key and the field map key. */
  id: string;
  /** Display name on the settings row. */
  name: string;
  /** Human-readable type label rendered in the Type column. */
  typeLabel: string;
  /** Whether the field is required at the task level. */
  required: boolean;
}

export const BUILT_IN_FIELDS: BuiltInField[] = [
  { id: 'phase', name: 'Phase', typeLabel: 'Single-select', required: true },
  { id: 'owner', name: 'Owner', typeLabel: 'Person', required: true },
  { id: 'duration', name: 'Duration', typeLabel: 'Duration', required: false },
  { id: 'risk', name: 'Risk', typeLabel: 'Single-select', required: false },
  { id: 'critical-path', name: 'Critical-path', typeLabel: 'Boolean (auto)', required: false },
];
