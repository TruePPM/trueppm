/**
 * Static frontend registry of user-scoped external task sources (#1420, ADR-0291).
 *
 * The client-side mirror of the OSS backend `EXTERNAL_TASK_SOURCES` registry
 * (ADR-0097 §1) — the sources a contributor can connect to pull their *own*
 * assigned items into My Work, read-only and one-way. It drives the "Available
 * sources" section of the personal Connected Accounts page.
 *
 * Boundary rule (ADR-0291 §Decision, CLAUDE.md Two-Repo Rule): this list holds
 * **only OSS-owned sources**. Enterprise sources (`servicenow`, `azure_devops`)
 * must never be hard-coded here — they register dynamically into the
 * `user_settings.connected_accounts` widget-registry slot at their AppConfig
 * `ready()`, and the page renders them through `EnterpriseProviderSlots`. Adding
 * an OSS source here is additive; listing an Enterprise source would be an
 * Apache-2.0 boundary leak.
 *
 * `available` = registered in the OSS backend today (a `GET
 * /me/connections/<provider>/` resolves). `coming_soon` = a planned OSS source
 * with no backend registration yet, shown as a non-actionable signal only.
 */

export type ExternalSourceStatus = 'available' | 'coming_soon';

export interface ExternalTaskSourceEntry {
  /** Registry key — matches the backend `EXTERNAL_TASK_SOURCES` source key. */
  provider: string;
  /** Display name (also drives the `SourceMark` initials). */
  name: string;
  /** One-line description of what pulling this source brings into My Work. */
  description: string;
  status: ExternalSourceStatus;
}

/**
 * OSS external task sources, in display order.
 *
 * - `jira` — the one source the OSS backend registers today (ADR-0097 §Decision
 *   #1: "OSS owns `jira` here, narrowly, for read-only personal pull").
 * - `github` — the natural next OSS source (user-scoped, one-way, read-only fits
 *   the same carve-out); shown `coming_soon` until its backend source lands.
 */
export const EXTERNAL_TASK_SOURCES: readonly ExternalTaskSourceEntry[] = [
  {
    provider: 'jira',
    name: 'Jira',
    description: 'Pull issues assigned to you into My Work.',
    status: 'available',
  },
  {
    provider: 'github',
    name: 'GitHub',
    description: 'Issues and pull requests assigned to you.',
    status: 'coming_soon',
  },
];
