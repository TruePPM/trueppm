import type { ReactNode } from 'react';
import type { SettingsNavGroup } from '../SettingsShell';
import {
  OverviewIcon,
  ResourcesIcon,
  WbsIcon,
  SprintIcon,
  SettingsIcon,
  ExternalLinkIcon,
  WarningIcon,
  GanttIcon,
} from '@/components/Icons';

/** Inline Activity icon for the System Health nav item (no lucide-react dep). */
function ActivityNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline trash icon for the Retention & purge / Trash nav items. */
function RetentionNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Inline broadcast/signal icon for the Observability nav item — OTLP export. */
function ObservabilityNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.93 4.93a10 10 0 0 0 0 14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 7.76a6 6 0 0 0 0 8.48M16.24 7.76a6 6 0 0 1 0 8.48"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

/** Inline lock icon for the Single sign-on nav item. */
function LockNavIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{children}</span>;
}

/**
 * Single source of truth for the workspace settings left rail (ADR-0146).
 *
 * The consolidated page (`/settings`) renders every config section inline on one
 * scrolling page and drives the rail by scroll-spy, so its config items carry NO
 * `to` (id-only — an item without a `to` is treated as inline by SettingsShell).
 * The off-route shells (System Health tools, Trash) render the same rail but must
 * navigate, so their config items deep-link to the consolidated page anchor
 * `/settings#<id>`. The System-group tool items (System health, Observability,
 * Retention & purge, Trash) always carry their own route `to` and `external: true`
 * regardless of mode — they open distinct pages, not scroll sections, so they are
 * grouped last (after the inline sections) and rendered with a ↗ affordance (#2252).
 *
 * Keeping the three shells fed from this one builder prevents the rail from
 * drifting out of sync — the defect this replaced (#2013): the Trash and System
 * Health shells had hand-copied `NAV_GROUPS` that omitted SSO and most of the
 * Delivery group.
 *
 * @param linked `false` → inline scroll-spy rail for the consolidated page;
 *   `true` → config items deep-link back to `/settings#<id>` for off-route shells.
 */
export function buildWorkspaceNavGroups({ linked }: { linked: boolean }): SettingsNavGroup[] {
  // Config sections are inline (no `to`) on the consolidated page and deep-links
  // on the off-route shells. System Health / Trash items always navigate.
  const anchor = (slug: string): string | undefined => (linked ? `/settings#${slug}` : undefined);

  return [
    {
      label: 'Organization',
      items: [
        { id: 'general', label: 'General',              to: anchor('general'), icon: <NavIcon><OverviewIcon aria-hidden="true" /></NavIcon> },
        { id: 'members', label: 'Members',              to: anchor('members'), icon: <NavIcon><ResourcesIcon aria-hidden="true" /></NavIcon> },
        { id: 'groups',  label: 'Groups & teams',       to: anchor('groups'),  icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'roles',   label: 'Roles & permissions',  to: anchor('roles'),   icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
        { id: 'sso',     label: 'Single sign-on',       to: anchor('sso'),     icon: <NavIcon><LockNavIcon /></NavIcon> },
      ],
    },
    {
      label: 'Delivery',
      items: [
        { id: 'methodology', label: 'Methodology defaults', to: anchor('methodology'), icon: <NavIcon><SprintIcon aria-hidden="true" /></NavIcon> },
        { id: 'schedule',    label: 'Schedule',             to: anchor('schedule'),    icon: <NavIcon><GanttIcon aria-hidden="true" /></NavIcon> },
        { id: 'calendar',    label: 'Working calendar',     to: anchor('calendar'),    icon: <NavIcon><GanttIcon aria-hidden="true" /></NavIcon> },
        { id: 'programs',    label: 'Programs',             to: anchor('programs'),    icon: <NavIcon><WbsIcon aria-hidden="true" /></NavIcon> },
        { id: 'attachments', label: 'Attachments',          to: anchor('attachments'), icon: <NavIcon><ExternalLinkIcon aria-hidden="true" /></NavIcon> },
        { id: 'email',       label: 'Email & SMTP',         to: anchor('email'),       icon: <NavIcon><SettingsIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    // The "Connections" nav group (Integrations + Webhooks & API) is removed from
    // OSS per ADR-0076; the routes remain as redirect shims (see router.tsx) and
    // Enterprise re-injects this group via the slot registry.
    {
      label: 'Danger',
      items: [
        { id: 'danger', label: 'Archive / Delete', to: anchor('danger'), icon: <NavIcon><WarningIcon aria-hidden="true" /></NavIcon> },
      ],
    },
    // System tools are separate routes (`external: true`), NOT inline scroll
    // sections — so this group sits AFTER the last inline section (Danger), not
    // between Delivery and Danger (#2252). Otherwise the consolidated page's
    // scroll flow (Organization → Delivery → Danger) skips past these un-
    // scroll-to-able rail entries, producing the jarring "Email → Archive/Delete"
    // jump with a dead zone where System appears to belong. Keeping the route-
    // departure tools last makes the inline scroll sections contiguous and marks
    // this group as a distinct "tool pages you open" cluster (reinforced by the
    // per-item ↗ affordance SettingsShell renders for `external` items).
    {
      label: 'System',
      items: [
        { id: 'health',        label: 'System health',     to: '/settings/health',           external: true, icon: <NavIcon><ActivityNavIcon /></NavIcon> },
        // Observability (OTLP telemetry export) is its own tool page (#2250) so
        // OTLP setup is discoverable in the rail instead of buried at the bottom
        // of the System Health monitoring readout. System Health keeps a one-line
        // export-status readout that cross-links here.
        { id: 'observability', label: 'Observability',     to: '/settings/observability',    external: true, icon: <NavIcon><ObservabilityNavIcon /></NavIcon> },
        { id: 'retention',     label: 'Retention & purge', to: '/settings/health/retention', external: true, icon: <NavIcon><RetentionNavIcon /></NavIcon> },
        { id: 'trash',         label: 'Trash',             to: '/settings/trash',            external: true, icon: <NavIcon><RetentionNavIcon /></NavIcon> },
      ],
    },
  ];
}
