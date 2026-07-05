import { describe, it, expect } from 'vitest';
import { assetParams, DEFAULT_ASSET_FILTERS } from './useAssets';

describe('assetParams', () => {
  it('always sends a page_size and omits unset filters', () => {
    expect(assetParams(DEFAULT_ASSET_FILTERS)).toEqual({ page_size: '30' });
  });

  it('maps kind / label / provider through', () => {
    const params = assetParams({ kind: 'link', label: 'spec', provider: 'github', q: '' });
    expect(params).toMatchObject({ kind: 'link', label: 'spec', provider: 'github' });
    expect(params.q).toBeUndefined();
  });

  it('trims q and drops it when blank', () => {
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, q: '  payments ' }).q).toBe('payments');
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, q: '   ' }).q).toBeUndefined();
  });

  it('omits kind when null (both sources)', () => {
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, kind: null }).kind).toBeUndefined();
  });
});
