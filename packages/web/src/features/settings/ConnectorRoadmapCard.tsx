/**
 * Integrations connector catalog (#588, corrected in #1622).
 *
 * Two sections:
 *  - "Available now" — connectors that already ship, each pointing to where the
 *    capability lives (an in-app page, a docs guide, or — for the task-level
 *    cloud-file preview — the task itself).
 *  - "Coming soon" — connectors still on the roadmap, with the tracking issue
 *    and the target milestone straight from `roadmap.md` / the tracker.
 *
 * Shared by the project- and program-scoped Integrations pages, which are
 * documented visual mirrors. A contributor or program manager landing on an
 * Integrations surface looking for Jira/GitHub sync (VoC 2026-05-21, Priya
 * hard-NO) sees both what already works and what is coming, instead of reading
 * the absence of connectors as "this product does not do this".
 *
 * This list is HAND-MAINTAINED: when a "Coming soon" connector ships, move it to
 * "Available now" (or drop it) and correct any milestone tags. It drifted badly
 * once (#1622 — three shipped connectors were still advertised as "coming" and
 * two future ones carried already-released 0.2/0.3 tags); binding it to a source
 * of truth so drift is structurally impossible is tracked in #1623.
 */

import { SettingsCard } from './SettingsShell';

const ISSUE_URL_BASE = 'https://gitlab.com/trueppm/trueppm/-/issues/';

/** A shipped connector, optionally pointing to where the capability lives. */
type AvailableConnector = {
  name: string;
  description: string;
  /**
   * Where to go to use it. `external` links open the published docs site in a
   * new tab (rule 212 — never an in-app docs route); in-app links route
   * within the SPA. Omitted when the capability has no destination of its own
   * (the cloud-file preview lives on the task, so linking anywhere is wrong).
   */
  link?: { label: string; href: string; external: boolean };
};

const AVAILABLE_CONNECTORS: AvailableConnector[] = [
  {
    name: 'Inbound Jira / Linear / GitHub task-sync',
    description: 'Pull issues and status changes from your existing tracker into this project.',
    link: {
      label: 'Set-up guide',
      href: 'https://docs.trueppm.com/features/inbound-task-sync',
      external: true,
    },
  },
  {
    name: 'Personal connected accounts',
    description: 'Per-user credentials for connectors that authenticate as you.',
    link: {
      label: 'Manage accounts',
      href: '/me/settings/connected-accounts',
      external: false,
    },
  },
  {
    name: 'Drive / Box / Dropbox URL preview',
    description: 'Paste a cloud-file link on any task for an inline preview — no account needed.',
  },
];

/** A connector still on the roadmap, with its tracking issue(s) and milestone. */
type RoadmapConnector = {
  name: string;
  description: string;
  issues: number[];
  milestone: string;
};

const ROADMAP_CONNECTORS: RoadmapConnector[] = [
  {
    name: 'Calendar export (Google Calendar / Outlook)',
    description: 'Publish milestones and deadlines to your team calendar.',
    issues: [570],
    milestone: '0.6',
  },
  {
    name: 'Zoom / Meet / Teams meeting links on milestones',
    description: 'Attach meeting links directly to schedule milestones.',
    issues: [572],
    milestone: '0.6',
  },
];

const SECTION_HEADER =
  'text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary';

const LINK_CLASS =
  'text-[12px] text-brand-primary underline-offset-2 hover:underline ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ' +
  'focus-visible:ring-offset-1 rounded';

export function ConnectorRoadmapCard() {
  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-baseline gap-2 border-b border-neutral-border/55">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary">Connectors</h2>
        <span className="text-[12px] text-neutral-text-secondary">What connects to your stack</span>
      </div>

      <div className="px-4 py-3 border-b border-neutral-border/55">
        <h3 className={SECTION_HEADER}>Available now</h3>
        <ul className="mt-2 space-y-3">
          {AVAILABLE_CONNECTORS.map((connector) => (
            <li key={connector.name} className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  {connector.name}
                </span>
                {connector.link &&
                  (connector.link.external ? (
                    <a
                      href={connector.link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={LINK_CLASS}
                    >
                      {connector.link.label} →
                    </a>
                  ) : (
                    <a href={connector.link.href} className={LINK_CLASS}>
                      {connector.link.label} →
                    </a>
                  ))}
              </div>
              <p className="text-[12px] text-neutral-text-secondary mt-0.5">
                {connector.description}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className={SECTION_HEADER}>Coming soon</h3>
          <span className="text-[11px] text-neutral-text-secondary">on the roadmap</span>
        </div>
        <ul className="mt-2 space-y-3">
          {ROADMAP_CONNECTORS.map((connector) => (
            <li key={connector.name} className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] font-medium text-neutral-text-primary">
                  {connector.name}
                </span>
                {connector.issues.map((issue) => (
                  <a
                    key={issue}
                    href={`${ISSUE_URL_BASE}${issue}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${LINK_CLASS} tppm-mono`}
                  >
                    #{issue}
                  </a>
                ))}
                <span className="text-[12px] text-neutral-text-secondary tppm-mono">
                  {connector.milestone}
                </span>
              </div>
              <p className="text-[12px] text-neutral-text-secondary mt-0.5">
                {connector.description}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </SettingsCard>
  );
}
