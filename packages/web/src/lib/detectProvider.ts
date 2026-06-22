/**
 * Client-side provider detection for a pasted task link (#637, #970).
 *
 * Mirrors the server's `TaskLinkProvider.matches()` for the SaaS hosts so the
 * add-link affordance can show a live "GitLab/GitHub detected" hint as the user
 * types. The server is authoritative — it re-resolves the provider on create
 * (including self-hosted hosts via the user's connected base_url, which the
 * client can't know) — so this is only a hint, never the stored value.
 *
 * Returns `null` for an empty or unparseable URL (hide the hint, disable Add);
 * `'generic'` for any well-formed http(s) URL that isn't a known SaaS host.
 *
 * The cloud-file hosts (issue 571, ADR-0163) mirror the server's `FileLinkProvider`
 * host sets so a pasted Drive/Dropbox/Box/OneDrive URL shows a "refresh loads a
 * preview" hint as the user types.
 */
export type DetectedProvider =
  | 'gitlab'
  | 'github'
  | 'google_drive'
  | 'dropbox'
  | 'box'
  | 'onedrive'
  | 'generic';

/**
 * File-host suffix → provider key. A host matches when it equals the suffix or
 * is a subdomain of it (`app.box.com` → `box`), exactly like the server's
 * `FileLinkProvider.matches`. The leading-dot subdomain check prevents a
 * suffix-spoof host (`box.com.evil.com`) from matching.
 */
const FILE_HOST_SUFFIXES: ReadonlyArray<readonly [string, DetectedProvider]> = [
  ['drive.google.com', 'google_drive'],
  ['docs.google.com', 'google_drive'],
  ['sheets.google.com', 'google_drive'],
  ['slides.google.com', 'google_drive'],
  ['dropbox.com', 'dropbox'],
  ['box.com', 'box'],
  ['onedrive.live.com', 'onedrive'],
  ['sharepoint.com', 'onedrive'],
  ['1drv.ms', 'onedrive'],
];

function matchFileHost(host: string): DetectedProvider | null {
  for (const [suffix, provider] of FILE_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return provider;
  }
  return null;
}

/**
 * Normalize a user-pasted URL to a safe http(s) absolute URL, or `null` (#970).
 *
 * A bare host/path with no scheme (`github.com/acme/api`) gets `https://`
 * prepended — mirrors the server's `validate_url`, so the **Add** affordance
 * enables on the same input the API accepts. Anything with an explicit scheme
 * is kept as-is so a deliberate `ftp:`/`javascript:` is rejected (returns
 * `null`) rather than coerced. Returns `null` for empty or unparseable input.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Has an explicit `scheme://` already? Keep it; otherwise default to https.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return candidate;
  } catch {
    return null;
  }
}

export function detectProvider(url: string): DetectedProvider | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const host = new URL(normalized).hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host === 'gitlab.com' || host === 'www.gitlab.com') return 'gitlab';
  return matchFileHost(host) ?? 'generic';
}
