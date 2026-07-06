import { useEffect } from 'react';

/**
 * Suppress the `Referer` header while a public share page is mounted (#1486
 * threat model, ADR-0265). A share token is a capability embedded in the URL; any
 * outbound navigation or third-party subresource would otherwise leak the full
 * tokenized URL via `Referer`. Injecting `<meta name="referrer" content="no-referrer">`
 * for the lifetime of the page closes that leak on both the board and schedule
 * public viewers without changing the authenticated app's referrer behavior.
 */
export function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);
}
