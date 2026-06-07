/**
 * Build an absolute URL into the TruePPM documentation site (#979).
 *
 * In-app "Learn more" / "Open runbook" links must resolve to the standalone
 * Astro docs site (published at `https://docs.trueppm.com`), not to a relative
 * `/docs/...` path on the app origin: the SPA has no `/docs` route and nothing
 * proxies that prefix to the docs site, so a relative link falls through to the
 * SPA catch-all and 404s in both local dev and the Helm deployment. The docs
 * site is served at the domain root (no `/docs` base), so a page path passed
 * here must NOT include a `/docs/` prefix — use the published slug directly,
 * e.g. `administration/system-health` or `features/connected-accounts`.
 *
 * Self-hosters who mirror the docs at a different origin can repoint every
 * in-app link at once via the `VITE_DOCS_BASE_URL` build-time env var.
 *
 * @param path - The docs-site page slug, e.g. `administration/system-health`.
 *   A leading slash is tolerated and stripped.
 * @returns An absolute `https://docs.trueppm.com/<path>` URL.
 */
export function docsUrl(path: string): string {
  const override: unknown = import.meta.env.VITE_DOCS_BASE_URL;
  const base = (
    typeof override === 'string' && override.length > 0 ? override : 'https://docs.trueppm.com'
  ).replace(/\/+$/, '');
  const slug = path.replace(/^\/+/, '');
  return `${base}/${slug}`;
}
