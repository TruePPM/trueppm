import { describe, expect, it } from 'vitest';
import { docsUrl } from './docsUrl';

describe('docsUrl', () => {
  it('builds an absolute docs.trueppm.com URL with no /docs prefix', () => {
    expect(docsUrl('administration/system-health')).toBe(
      'https://docs.trueppm.com/administration/system-health',
    );
  });

  it('tolerates a leading slash on the slug', () => {
    expect(docsUrl('/features/connected-accounts')).toBe(
      'https://docs.trueppm.com/features/connected-accounts',
    );
  });
});

/**
 * Regression guard (#979): in-app documentation links must go through
 * `docsUrl()` and resolve to the standalone docs site. A bare relative
 * `href="/docs/..."` falls through to the SPA catch-all and 404s in both local
 * dev and the Helm deployment — the exact bug this change fixes. Fail the suite
 * if any source file reintroduces a literal `/docs/` href.
 */
describe('no relative /docs/ hrefs in source', () => {
  const modules = import.meta.glob('../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('every source file is free of literal "/docs/" link targets', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(modules)) {
      // Skip the helper + this guard file; both necessarily document the pattern.
      if (path.includes('docsUrl')) continue;
      if (typeof source === 'string' && /["'`]\/docs\//.test(source)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
