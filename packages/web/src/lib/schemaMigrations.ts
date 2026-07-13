/**
 * Forward-migration registry for user-saved JSON state (ADR-0086 / ADR-0204).
 *
 * Mirror of the API-side registry
 * (`packages/api/src/trueppm_api/apps/projects/schema_migrations.py`). Every
 * user-saved JSON payload (saved views, filters, dashboards) carries a
 * `schema_version`. No consumer reads a raw stored payload; it dispatches
 * through this registry, which upgrades a payload to the current version on read
 * before any business logic sees it.
 *
 * Contract (identical to the API side):
 * - A payload with no `schema_version` is treated as version 0.
 * - A payload at a version newer than this code supports is a hard error, not a
 *   silent best-effort read.
 * - Surface keys are shared string constants so the two registries stay auditable
 *   against each other.
 */

/** A single `v(n) -> v(n+1)` transform. Pure; receives a payload at `from`, returns it at `from + 1`. */
export type Migration = (payload: Record<string, unknown>) => Record<string, unknown>;

/** Stable surface keys — mirror `SURFACE_*` in the API registry. */
export const SURFACE_BOARD_SAVED_VIEW = 'board_saved_view';

interface SurfaceRegistration {
  currentVersion: number;
  /** Map of `from_version` -> transform to `from_version + 1`. */
  steps: Map<number, Migration>;
}

const registry = new Map<string, SurfaceRegistration>();

/** Register a surface and its current schema version. */
export function registerSurface(surface: string, currentVersion: number): void {
  const existing = registry.get(surface);
  if (existing) {
    existing.currentVersion = currentVersion;
  } else {
    registry.set(surface, { currentVersion, steps: new Map() });
  }
}

/** Register a single `fromVersion -> fromVersion + 1` transform for a surface. */
export function registerMigration(surface: string, fromVersion: number, fn: Migration): void {
  let entry = registry.get(surface);
  if (!entry) {
    entry = { currentVersion: 1, steps: new Map() };
    registry.set(surface, entry);
  }
  entry.steps.set(fromVersion, fn);
}

/** Current schema version for a surface (defaults to 1 if unregistered). */
export function currentVersion(surface: string): number {
  return registry.get(surface)?.currentVersion ?? 1;
}

/** Version stored in a payload, treating an absent/invalid key as 0. */
export function storedVersion(payload: Record<string, unknown> | null | undefined): number {
  const raw = payload?.['schema_version'];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Upgrade a stored payload to the surface's current version on read.
 *
 * Applies the ordered `v(n) -> v(n+1)` chain until the payload is current, then
 * stamps `schema_version`. Re-running against an already-current payload is a
 * no-op, so this is idempotent.
 *
 * @throws Error if the payload is at a version newer than this code supports, or
 *   if a step is missing from the chain (a version bump landed without its
 *   transform).
 */
export function migratePayload(
  surface: string,
  payload: Record<string, unknown>,
  fromVersion?: number,
): { payload: Record<string, unknown>; version: number } {
  const target = currentVersion(surface);
  let version = fromVersion ?? storedVersion(payload);

  if (version > target) {
    throw new Error(
      `Payload for surface "${surface}" is at schema_version ${version}, but this code only supports up to ${target}.`,
    );
  }

  let result: Record<string, unknown> = { ...payload };
  const steps = registry.get(surface)?.steps ?? new Map<number, Migration>();
  while (version < target) {
    const transform = steps.get(version);
    if (!transform) {
      throw new Error(
        `No migration registered for surface "${surface}" from version ${version} (current version is ${target}).`,
      );
    }
    result = transform(result);
    version += 1;
  }

  result['schema_version'] = target;
  return { payload: result, version: target };
}

// ---------------------------------------------------------------------------
// board_saved_view surface (issue 191, useBoardSavedViews)
// ---------------------------------------------------------------------------

/** The six canonical config keys and their defaults — mirror of the API side. */
const BOARD_VIEW_DEFAULTS: Record<string, unknown> = {
  sort: 'priority',
  show_wip: true,
  show_col_tints: true,
  evm_mode: 'off',
  show_cost: false,
  risk_linked_only: false,
};

/** Backfill the canonical config keys on a pre-convention (v0) board view payload. */
function boardViewV0ToV1(payload: Record<string, unknown>): Record<string, unknown> {
  const upgraded = { ...payload };
  for (const [key, value] of Object.entries(BOARD_VIEW_DEFAULTS)) {
    if (upgraded[key] === undefined) {
      upgraded[key] = value;
    }
  }
  return upgraded;
}

/**
 * The three filter-facet keys added in v2 (issue 1918) — mirror of the API-side
 * `_BOARD_VIEW_FACET_DEFAULTS`. An empty list means "no constraint", matching
 * `boardFacets.EMPTY_FACETS`.
 */
const BOARD_VIEW_FACET_DEFAULTS: Record<string, unknown> = {
  filter_assignees: [],
  filter_priority: [],
  filter_due: [],
};

/** Backfill the filter-facet keys onto a pre-#1918 (v1) board view payload. */
function boardViewV1ToV2(payload: Record<string, unknown>): Record<string, unknown> {
  const upgraded = { ...payload };
  for (const [key, value] of Object.entries(BOARD_VIEW_FACET_DEFAULTS)) {
    if (upgraded[key] === undefined) {
      upgraded[key] = value;
    }
  }
  return upgraded;
}

registerSurface(SURFACE_BOARD_SAVED_VIEW, 2);
registerMigration(SURFACE_BOARD_SAVED_VIEW, 0, boardViewV0ToV1);
registerMigration(SURFACE_BOARD_SAVED_VIEW, 1, boardViewV1ToV2);
