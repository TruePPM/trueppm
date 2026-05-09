/**
 * Frontend slot registry — OSS extension boundary between the community shell
 * and enterprise overlay code (ADR-0029).
 *
 * OSS components call registry.get(slot) to render registered components
 * alongside their defaults. Enterprise code calls registry.register(slot, ...)
 * once at startup. Empty slots produce no output — no conditional edition
 * checks appear in OSS components.
 *
 * SlotId is the public contract between the two repos. Additions are
 * non-breaking; renames and removals are major-version changes.
 */

import type { ComponentType } from 'react';

export type SlotId =
  | 'project_overview.kpi_row'       // additional KPI cards right of the 4 OSS cards
  | 'project_overview.hero_right'    // replaces/extends the "Needs attention" panel
  | 'project_overview.below_hero'    // rows injected below the hero row
  | 'nav.portfolio_section'          // nav rail section above the project switcher
  | 'top_bar.context'                // items to the right of the project name chip
  | 'routes'                         // additional React Router routes (path + element)
  // --- Resource catalog slots (issue #155, ADR-0034) ---
  | 'resources_page.toolbar_end'        // Enterprise: "Sync from LDAP" button + last-synced timestamp
  | 'resources_page.detail_managed_by'  // Enterprise: "Managed by Active Directory" badge in detail pane
  | 'resources_page.create_form_extension' // Enterprise: extra fields in the create/edit form
  // --- Resource heatmap slots (issue #217 / ADR-0042) ---
  | 'resources_heatmap.level_loads'     // Enterprise: replaces the static disabled "Level loads" upsell button
  // --- Task detail drawer slots (issue #309 / ADR-0050) ---
  | 'task_detail.section';              // sections inside TaskDetailDrawer (OSS + Enterprise)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SlotRegistration<T = ComponentType<any>> {
  /** Stable unique key for the registration. */
  id: string;
  component: T;
  /** Lower priority values are rendered first. */
  priority: number;
  /**
   * Optional display title. Required for `task_detail.section` registrations
   * (ADR-0050) — used as the collapsible header label. Ignored by other slots.
   */
  title?: string;
  /**
   * Optional predicate that hides the registration entirely when it returns
   * false. The context shape is slot-specific; consumers cast as needed. Used
   * by `task_detail.section` to gate Enterprise-only sections without OSS
   * knowing about licensing rules.
   */
  canRender?: (ctx: unknown) => boolean;
}

export class WidgetRegistry {
  private readonly slots = new Map<SlotId, SlotRegistration[]>();

  /**
   * Register a component for a named slot.
   *
   * Idempotent: re-registering the same `(slot, id)` replaces the prior
   * entry rather than appending a duplicate. Vite HMR, module re-imports,
   * and React StrictMode's double-invoke all cause init code to run twice;
   * without dedupe every section was rendered twice in the task detail
   * drawer (and any other slot). Replace-by-id also lets HMR pick up the
   * new component when a section is edited mid-session.
   *
   * Registrations are sorted by priority (ascending) on each call so that
   * get() returns them in the correct render order without a sort at read time.
   */
  register(slot: SlotId, reg: SlotRegistration): void {
    const existing = (this.slots.get(slot) ?? []).filter((r) => r.id !== reg.id);
    this.slots.set(
      slot,
      [...existing, reg].sort((a, b) => a.priority - b.priority),
    );
  }

  /**
   * Return all registrations for a slot in priority order.
   * Returns an empty array when no components have been registered.
   */
  get(slot: SlotId): SlotRegistration[] {
    return this.slots.get(slot) ?? [];
  }
}

/** Singleton registry shared by the OSS shell and the enterprise overlay. */
export const registry = new WidgetRegistry();

// ---------------------------------------------------------------------------
// Task detail drawer section registrations (ADR-0050)
// ---------------------------------------------------------------------------

/**
 * Props every component registered against `task_detail.section` receives.
 * The drawer passes only identifiers; sections own their own data fetching
 * via TanStack Query keyed by these props (per ADR-0050 §Decision).
 */
export interface DrawerSectionProps {
  taskId: string;
  projectId: string;
}

/**
 * Context passed to `canRender` for drawer-section registrations. Sections
 * use this to gate visibility — typically Enterprise sections check whether
 * the user holds the required license/role. OSS sections rarely need it.
 */
export interface DrawerSectionContext {
  /** Authenticated user object — exact shape lives in `@/types`. */
  user: unknown;
  /** Current task object the drawer is rendering. */
  task: unknown;
}

/**
 * Typed alias of {@link SlotRegistration} for the `task_detail.section` slot.
 * `title` is required (used as the section header / tab label).
 *
 * Priority allocation (per ADR-0050) — OSS reserves multiples of 100:
 *  100 Overview · 200 Dependencies · 300 Subtasks · 400 Attachments
 *  500 Comments · 600 Activity · 700 Recurring · 800 Estimates
 *  900 History · 1000 Baseline. Enterprise picks any non-multiple of 100
 *  between (e.g. 250 for Custom Fields).
 */
export interface DrawerSectionRegistration
  extends Omit<SlotRegistration<ComponentType<DrawerSectionProps>>, 'canRender'> {
  title: string;
  canRender?: (ctx: DrawerSectionContext) => boolean;
}
