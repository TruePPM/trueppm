import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

import { assetParams, DEFAULT_ASSET_FILTERS, openAssetDownload } from './useAssets';

describe('assetParams', () => {
  it('always sends a page_size and omits unset filters', () => {
    expect(assetParams(DEFAULT_ASSET_FILTERS)).toEqual({ page_size: '30' });
  });

  it('maps kind / label / provider / program through', () => {
    const params = assetParams({
      kind: 'link',
      label: 'spec',
      provider: 'github',
      program: 'prog-1',
      q: '',
    });
    expect(params).toMatchObject({
      kind: 'link',
      label: 'spec',
      provider: 'github',
      program: 'prog-1',
    });
    expect(params.q).toBeUndefined();
  });

  it('omits program when null', () => {
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, program: null }).program).toBeUndefined();
  });

  it('trims q and drops it when blank', () => {
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, q: '  payments ' }).q).toBe('payments');
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, q: '   ' }).q).toBeUndefined();
  });

  it('omits kind when null (both sources)', () => {
    expect(assetParams({ ...DEFAULT_ASSET_FILTERS, kind: null }).kind).toBeUndefined();
  });
});

describe('openAssetDownload', () => {
  const openSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('open', openSpy);
    getMock.mockResolvedValue({ data: { url: 'https://s3/signed', expires_at: 'x' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips the /api/v1 prefix so apiClient does not double it', async () => {
    await openAssetDownload('/api/v1/attachments/a1/download_url/');

    expect(getMock).toHaveBeenCalledWith('/attachments/a1/download_url/');
    expect(openSpy).toHaveBeenCalledWith('https://s3/signed', '_blank', 'noopener,noreferrer');
  });

  it('also reduces a fully-qualified download_url to a baseURL-relative path (#3467)', async () => {
    // The previous `^/api/v1` anchor could not match an absolute URL, so one
    // would have passed through untouched — and axios does not prefix its
    // baseURL onto an absolute URL, sending the request to whatever host the
    // server wrote into the link.
    await openAssetDownload('http://api:8000/api/v1/attachments/a1/download_url/');

    expect(getMock).toHaveBeenCalledWith('/attachments/a1/download_url/');
  });

  it('leaves a path with no API prefix alone', async () => {
    await openAssetDownload('/attachments/a1/download_url/');

    expect(getMock).toHaveBeenCalledWith('/attachments/a1/download_url/');
  });

  it('does not open a window when the response carries no url', async () => {
    getMock.mockResolvedValueOnce({ data: {} });

    await openAssetDownload('/api/v1/attachments/a1/download_url/');

    expect(openSpy).not.toHaveBeenCalled();
  });
});
