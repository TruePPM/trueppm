/**
 * Client-side provider detection for a pasted task link (#637).
 *
 * Mirrors the server's `TaskLinkProvider.matches()` for the SaaS hosts so the
 * add-link affordance can show a live "GitLab/GitHub detected" hint as the user
 * types. The server is authoritative — it re-resolves the provider on create
 * (including self-hosted hosts via the user's connected base_url, which the
 * client can't know) — so this is only a hint, never the stored value.
 *
 * Returns `null` for an empty or unparseable URL (hide the hint, disable Add);
 * `'generic'` for any well-formed http(s) URL that isn't a known SaaS host.
 */
export type DetectedProvider = 'gitlab' | 'github' | 'generic';

export function detectProvider(url: string): DetectedProvider | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host === 'gitlab.com' || host === 'www.gitlab.com') return 'gitlab';
  return 'generic';
}
