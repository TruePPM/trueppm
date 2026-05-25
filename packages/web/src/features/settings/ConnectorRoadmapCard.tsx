/**
 * "Coming soon" connector roadmap callout (#588).
 *
 * Shared by the project- and program-scoped Integrations pages, which are
 * documented visual mirrors. A contributor or program manager landing on an
 * Integrations surface looking for Jira/GitHub sync (VoC 2026-05-21, Priya
 * hard-NO) otherwise reads the absence of connectors as "this product does not
 * do this" instead of "this is coming." Each row links to the tracking
 * issue(s) — no functionality, a roadmap pointer only.
 *
 * Single source of truth for the connector list: both pages import this so the
 * roadmap only needs updating in one place as connectors ship.
 */

import { SettingsCard } from './SettingsShell';

const ISSUE_URL_BASE = 'https://gitlab.com/trueppm/trueppm/-/issues/';

const ROADMAP_CONNECTORS: {
  name: string;
  description: string;
  issues: number[];
  milestone: string;
}[] = [
  {
    name: 'Inbound Jira / Linear / GitHub task-sync',
    description: 'Pull issues and status changes from your existing tracker into this project.',
    issues: [500, 488],
    milestone: '0.3',
  },
  {
    name: 'Calendar export (Google Calendar / Outlook)',
    description: 'Publish milestones and deadlines to your team calendar.',
    issues: [570],
    milestone: '0.3',
  },
  {
    name: 'Drive / Box / Dropbox URL preview',
    description: 'Inline previews for document links pasted into tasks.',
    issues: [571],
    milestone: '0.3',
  },
  {
    name: 'Zoom / Meet / Teams meeting links on milestones',
    description: 'Attach meeting links directly to schedule milestones.',
    issues: [572],
    milestone: '0.3',
  },
  {
    name: 'Personal connected accounts',
    description: 'Per-user credentials for connectors that authenticate as you.',
    issues: [587],
    milestone: '0.2',
  },
];

export function ConnectorRoadmapCard() {
  return (
    <SettingsCard>
      <div className="px-4 pt-3.5 pb-2 flex items-baseline gap-2 border-b border-neutral-border/55">
        <h2 className="text-[14px] font-semibold text-neutral-text-primary">Coming soon</h2>
        <span className="text-[12px] text-neutral-text-secondary">
          Connectors on the roadmap
        </span>
      </div>
      <ul className="px-4 py-3 space-y-3">
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
                  className="text-[12px] text-brand-primary underline-offset-2 hover:underline
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                             focus-visible:ring-offset-1 rounded tppm-mono"
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
    </SettingsCard>
  );
}
