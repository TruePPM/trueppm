/**
 * Validate a user-supplied URL before binding it to an anchor `href` or
 * passing it to `window.open` (#898).
 *
 * React does not strip dangerous schemes from a string `href`, so a stored
 * `javascript:` or `data:` URL on a task link or pinned attachment would
 * execute on click (stored XSS). This guard rejects anything that is not a
 * well-formed `http(s)` URL, returning `null` so callers can render an inert
 * fallback instead of a clickable link.
 *
 * @param url - The raw, user-supplied URL string to validate.
 * @returns The original URL if it is a safe `http:`/`https:` link, otherwise
 *   `null` (for other schemes such as `javascript:`/`data:`, or unparseable
 *   input).
 */
export function safeExternalHref(url: string): string | null {
  try {
    const proto = new URL(url).protocol;
    return proto === 'http:' || proto === 'https:' ? url : null;
  } catch {
    return null;
  }
}
