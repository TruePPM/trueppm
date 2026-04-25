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
  | 'resources_page.create_form_extension'; // Enterprise: extra fields in the create/edit form

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SlotRegistration<T = ComponentType<any>> {
  /** Stable unique key for the registration. */
  id: string;
  component: T;
  /** Lower priority values are rendered first. */
  priority: number;
}

class WidgetRegistry {
  private readonly slots = new Map<SlotId, SlotRegistration[]>();

  /**
   * Register a component for a named slot.
   *
   * Registrations are sorted by priority (ascending) on each call so that
   * get() returns them in the correct render order without a sort at read time.
   */
  register(slot: SlotId, reg: SlotRegistration): void {
    const existing = this.slots.get(slot) ?? [];
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
