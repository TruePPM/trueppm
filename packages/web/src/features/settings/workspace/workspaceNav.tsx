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
 * The consolidated page (`/settings`) renders every section inline on one
 * scrolling page and drives the rail by scroll-spy, so its items carry NO `to`
 * (id-only — an item without a `to` is treated as inline by SettingsShell). The
 * off-route shells (System Health tools, Trash) render the same rail but must
 * navigate, so their items deep-link to the consolidated page anchor
 * `/settings#<id>`.
 *
 * The System group is now part of that same scroll surface (#2298): Observability
 * and Retention & purge render their full config forms inline, while System health
 * (a live monitoring console) and Trash (a data list) render scroll-reachable
 * landing cards that link to their full route. So EVERY item is a scroll anchor —
 * there is no `external` route-departure group any more, and the "Opens a separate
 * page" caption / divider (#2291) drops out automatically once no item is external.
 * The System group stays LAST so the scroll order (Organization → Delivery → Danger
 * → System) reads top-to-bottom.
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
    // System is now part of the consolidated scroll surface (#2298), so its items
    // are scroll anchors like every other group — NOT `external` route departures.
    // Kept LAST so the scroll order stays Organization → Delivery → Danger → System.
    // On the consolidated page (linked:false) these anchor-scroll to the inline
    // Observability/Retention forms and the System-health/Trash landing cards; on
    // the off-route shells (linked:true) they deep-link back to `/settings#<id>`.
    {
      label: 'System',
      items: [
        { id: 'health',        label: 'System health',     to: anchor('health'),        icon: <NavIcon><ActivityNavIcon /></NavIcon> },
        // Observability (OTLP telemetry export) — a config form, rendered inline
        // on the consolidated page (#2298); still discoverable in the rail by name.
        { id: 'observability', label: 'Observability',     to: anchor('observability'), icon: <NavIcon><ObservabilityNavIcon /></NavIcon> },
        { id: 'retention',     label: 'Retention & purge', to: anchor('retention'),     icon: <NavIcon><RetentionNavIcon /></NavIcon> },
        { id: 'trash',         label: 'Trash',             to: anchor('trash'),         icon: <NavIcon><RetentionNavIcon /></NavIcon> },
      ],
    },
  ];
}
