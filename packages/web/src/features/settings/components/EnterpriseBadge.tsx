import { useEdition } from '@/hooks/useEdition';

const ENTERPRISE_URL = 'https://trueppm.com/enterprise';

/**
 * Inline upsell affordance for an Enterprise-only capability or action sitting
 * on an OSS surface (#541, frontend rule 121). The badge IS the link — a hover
 * tooltip that contains a link is unreachable (it dismisses as the pointer
 * travels to the link and is invisible to keyboard users), so the badge
 * navigates directly to the Enterprise page and exposes "Available in TruePPM
 * Enterprise" via title + aria-label. This turns a previously dead Enterprise
 * affordance (a checkmark, or a button that does nothing in OSS) into a
 * purchase-decision path.
 *
 * Rendered only under the community edition; under the enterprise edition the
 * capability is actually available, so the badge would be noise and is
 * suppressed. The edition gate lives here so no caller can forget it.
 */
export function EnterpriseBadge() {
  const { edition } = useEdition();
  if (edition !== 'community') return null;
  return (
    <a
      href={ENTERPRISE_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Available in TruePPM Enterprise"
      aria-label="Available in TruePPM Enterprise — learn more"
      className="ml-2 inline-flex items-center rounded bg-brand-primary/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-primary hover:bg-brand-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      EE
    </a>
  );
}
