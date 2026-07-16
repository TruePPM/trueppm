/**
 * "Open-source core" chip for the SSO sign-in path (#1392, ADR-0187 §6).
 *
 * Basic OIDC/OAuth login is part of the Apache-2.0 community edition — the auth
 * carve-out draws the line at identity *governance* (SAML/SCIM/directory sync),
 * not login federation. This chip makes that explicit next to the SSO button so
 * a self-hoster is never left wondering whether login federation is paywalled
 * (the "SSO tax" the feature exists to kill). It is purely informational: unlike
 * {@link EnterpriseBadge} it is not an upsell and carries no edition gate — the
 * SSO login path is OSS in every edition.
 */
export function OSSChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-semantic-on-track-bg px-2 py-0.5 text-xs font-medium text-semantic-on-track ${className}`}
      title="Open-source core — no Enterprise license required"
    >
      <span aria-hidden="true">◆</span>
      Open-source core · no Enterprise license required
    </span>
  );
}
