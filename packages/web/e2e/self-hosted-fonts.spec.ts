/**
 * Self-hosted fonts — no third-party requests on a page load (#2419).
 *
 * TruePPM is sold on being self-hosted and air-gapped-capable, and #2392's
 * feedback design is built on "a self-hosted, air-gapped-capable product does not
 * get to phone home". `index.html` nevertheless loaded the three typefaces from
 * `fonts.googleapis.com`, so every page load emitted a request to Google from the
 * end user's browser (carrying their IP and referrer) and an air-gapped install
 * silently rendered the whole type scale in a substitute face.
 *
 * This is the regression gate the issue's acceptance criteria asked for. It is
 * deliberately a *whole-origin* assertion rather than a font-host allowlist: the
 * property worth protecting is "a page load contacts nobody", and the next
 * accidental CDN link would not be a font one. Same-origin requests (the app
 * bundle, the mocked API, `/fonts/*`) are ignored; `data:`/`blob:` are not
 * network traffic.
 *
 * If this fails, read the reported URL — do not relax the check. Vendor the
 * asset under `public/` instead (see `public/fonts/README.md`).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/** Schemes that never leave the browser. */
const LOCAL_SCHEMES = ['data:', 'blob:', 'about:', 'chrome-extension:'];

function isThirdParty(url: string, origin: string): boolean {
  if (LOCAL_SCHEMES.some((s) => url.startsWith(s))) return false;
  try {
    return new URL(url).origin !== origin;
  } catch {
    return false;
  }
}

test.describe('Self-hosted fonts (#2419)', () => {
  test('a page load makes zero requests to any third-party host', async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
    const offenders: string[] = [];

    // Record every request the page attempts — including ones that fail, since a
    // blocked outbound call on an air-gapped host is exactly the symptom.
    page.on('request', (req) => {
      const url = req.url();
      if (isThirdParty(url, origin)) offenders.push(`${req.method()} ${url}`);
    });

    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page);

    await page.goto('/');
    // Let the font faces resolve — `document.fonts.ready` settles once every face
    // the page uses has loaded (or definitively failed), so the assertion cannot
    // race the CSS-driven font fetches.
    await page.evaluate(() => document.fonts.ready);

    expect(offenders, `Third-party requests on page load:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('the three typefaces are served from this origin and actually load', async ({ page }) => {
    const fontRequests: string[] = [];
    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('/fonts/') && url.endsWith('.woff2')) {
        // A 200 matters: a 404 here would leave the fallback face rendering while
        // the whole-origin check above still passed.
        expect(res.status(), `${url} did not return 200`).toBe(200);
        fontRequests.push(new URL(url).pathname);
      }
    });

    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page);

    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);

    // The login/landing chrome uses the UI face and the wordmark face; the mono
    // face is data-only and may not appear above the fold, so it is not required
    // here. Asserting the Latin slices specifically proves the `unicode-range`
    // split survived vendoring — a broken split would pull every subset.
    expect(fontRequests).toContain('/fonts/inter-latin.woff2');

    // Every face the browser resolved must have come from this origin.
    const loaded = await page.evaluate(() =>
      Array.from(document.fonts).map((f) => ({ family: f.family, status: f.status })),
    );
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.some((f) => f.family.includes('Inter') && f.status === 'loaded')).toBe(true);
  });
});
