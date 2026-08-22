/**
 * Section id → documentation slug for every Settings section (ADR-0682).
 *
 * `SettingsShell` provides its `scope`; `SettingsSection` resolves this map with
 * its own `id` and hands the result to `SettingsPageTitle`, which renders the
 * "Learn more →" link at the tail of the section subtitle. No section component
 * reads this file — the whole help surface is configured here so it can be
 * reviewed, and tested, in one place.
 *
 * Slugs are docs-site paths **without** a leading slash, in the shape `docsUrl()`
 * expects (rule 212) — `administration/project-settings/#general`, never an
 * app-origin path under the `/docs` prefix, which has no SPA route and 404s
 * (#979). A trailing slash before the fragment matches how Starlight serves the
 * page.
 *
 * Two tests in `settingsDocs.test.ts` keep this honest, because two different
 * things rot:
 *   1. *Coverage* — every nav item in every scope has an entry here, and no entry
 *      is an orphan. A new section cannot ship without help.
 *   2. *Resolution* — every slug names a file that exists under
 *      `packages/website/src/content/docs/`, and every `#fragment` names a heading
 *      that exists in it. Renaming a docs heading fails the web suite rather than
 *      silently producing a dead in-product link.
 *
 * When a section has no documentation of its own yet, point at the parent page
 * *without* a fragment rather than inventing an anchor — a link to a real page
 * that is merely general is honest; a link to a heading that does not exist is not.
 */

export type SettingsScope = 'workspace' | 'program' | 'project';

/**
 * Workspace sections. Most delegate to a dedicated administration page rather
 * than to a `workspace-settings.md` anchor, because the operator-facing topics
 * (SSO, RBAC, retention, observability) are documented at far greater length on
 * their own pages than a settings-page summary could justify.
 */
const WORKSPACE_DOCS: Record<string, string> = {
  general: 'administration/workspace-settings/#general-settingsgeneral',
  members: 'administration/workspace-settings/#members-settingsmembers',
  groups: 'administration/workspace-settings/#groups--teams-settingsgroups',
  roles: 'administration/rbac/',
  sso: 'administration/single-sign-on/',
  methodology: 'features/methodology-preset/',
  schedule: 'features/scheduler/',
  calendar: 'administration/working-calendars/',
  programs: 'administration/workspace-settings/#programs-settingsprograms',
  attachments: 'administration/attachment-policy/',
  email: 'administration/email/',
  danger: 'administration/workspace-settings/#archive--delete',
  health: 'administration/system-health/',
  'rate-limit': 'administration/configuration/#general-api-rate-limiting',
  observability: 'administration/observability/',
  retention: 'administration/retention/',
  feedback: 'administration/configuration/#in-product-feedback-report-a-bug',
  'demo-data': 'getting-started/try-it/#inspect-before-you-import',
  trash: 'administration/retention/#trashed-projects-are-hard-deleted-after-the-window',
};

/**
 * Program sections. `program-settings.md` already carried a `##` heading for
 * every one of these before this feature existed — the anchors were written and
 * simply never linked from the product (#2487).
 */
const PROGRAM_DOCS: Record<string, string> = {
  general: 'administration/program-settings/#general',
  projects: 'administration/program-settings/#projects',
  access: 'administration/program-settings/#access',
  stakeholders: 'administration/program-settings/#external-stakeholders',
  rollup: 'features/settings/program-rollup/',
  cadence: 'administration/program-settings/#cadence',
  calendar: 'administration/program-settings/#working-calendar',
  risk: 'features/settings/program-risk-policy/',
  attachments: 'administration/program-settings/#attachments',
  integrations: 'administration/program-settings/#integrations',
  lifecycle: 'administration/program-settings/#lifecycle',
};

/** Project sections. */
const PROJECT_DOCS: Record<string, string> = {
  general: 'administration/project-settings/#general',
  access: 'features/settings/project-members/',
  agents: 'administration/mcp-server/#team-level-opt-out',
  methodology: 'features/methodology-preset/',
  templates: 'features/project-templates/#publishing-a-template',
  'template-divergence': 'features/project-templates/#template-divergence',
  team: 'features/settings/project-team/',
  workflow: 'administration/project-settings/#workflow--fields',
  labels: 'features/labels/',
  calendars: 'administration/working-calendars/',
  guardrails: 'administration/project-settings/#sprint-guardrails',
  'signal-privacy': 'features/settings/signal-privacy/',
  attachments: 'administration/attachment-policy/',
  surfaces: 'administration/project-settings/#surfaces',
  sharing: 'administration/sharing-and-access/',
  integrations: 'administration/project-settings/#integrations',
  notifications: 'features/settings/project-notifications/',
  lifecycle: 'administration/project-settings/#lifecycle',
};

/** The full section-id → docs-slug map, keyed by settings scope. */
export const SETTINGS_DOCS: Record<SettingsScope, Record<string, string>> = {
  workspace: WORKSPACE_DOCS,
  program: PROGRAM_DOCS,
  project: PROJECT_DOCS,
};

/**
 * The docs slug for a settings section, or `undefined` when the section has no
 * mapping.
 *
 * Returning `undefined` rather than throwing is deliberate: an unmapped section
 * degrades to rendering no help link, which is the pre-#2487 status quo for that
 * section. A missing entry is a test failure at build time, never a broken page
 * at runtime.
 */
export function settingsDocsSlug(scope: SettingsScope, sectionId: string): string | undefined {
  return SETTINGS_DOCS[scope][sectionId];
}
