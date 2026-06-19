import { Navigate, useParams } from 'react-router';

/**
 * Legacy per-section settings redirect (ADR-0146, #1248).
 *
 * The settings IA is now ONE scrolling page per entity; sections are anchors,
 * not routes. Old bookmarks / emails / e2e specs that point at
 * `…/settings/<slug>` are redirected to the consolidated page at the matching
 * anchor (`…/settings#<slug>`), so existing links keep working.
 *
 * `base` is the entity's settings root with `:projectId` / `:programId`
 * placeholders the router fills from the matched params.
 */
interface SectionRedirectProps {
  /** Settings root, e.g. `/settings`, `/projects/:projectId/settings`. */
  base: string;
  /** Anchor slug to scroll to, e.g. `methodology`. */
  anchor: string;
}

export function SectionRedirect({ base, anchor }: SectionRedirectProps) {
  const params = useParams();
  // Substitute any :param placeholders in the base with the matched values.
  const resolved = base.replace(/:(\w+)/g, (_, key: string) => params[key] ?? '');
  return <Navigate to={`${resolved}#${anchor}`} replace />;
}
