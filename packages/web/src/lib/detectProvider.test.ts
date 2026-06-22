import { describe, expect, it } from 'vitest';
import { detectProvider, normalizeUrl } from './detectProvider';

describe('detectProvider', () => {
  it('detects github.com (with or without www)', () => {
    expect(detectProvider('https://github.com/acme/api/pull/5')).toBe('github');
    expect(detectProvider('https://www.github.com/acme/api/issues/5')).toBe('github');
  });

  it('detects gitlab.com', () => {
    expect(detectProvider('https://gitlab.com/acme/api/-/merge_requests/5')).toBe('gitlab');
  });

  it('detects providers from a bare (scheme-less) URL (#970)', () => {
    expect(detectProvider('github.com/acme/api/pull/5')).toBe('github');
    expect(detectProvider('gitlab.com/acme/api/-/merge_requests/5')).toBe('gitlab');
    expect(detectProvider('example.com/some/doc')).toBe('generic');
  });

  it('detects cloud-file hosts (#571)', () => {
    expect(detectProvider('https://drive.google.com/file/d/x/view')).toBe('google_drive');
    expect(detectProvider('https://docs.google.com/document/d/x/edit')).toBe('google_drive');
    expect(detectProvider('https://www.dropbox.com/s/abc/f.pdf')).toBe('dropbox');
    expect(detectProvider('https://app.box.com/s/abc')).toBe('box');
    expect(detectProvider('https://acme.sharepoint.com/:f:/x')).toBe('onedrive');
    expect(detectProvider('https://onedrive.live.com/x')).toBe('onedrive');
  });

  it('does not match a suffix-spoof host as a file provider (#571)', () => {
    expect(detectProvider('https://box.com.evil.com/s/abc')).toBe('generic');
    expect(detectProvider('https://notdropbox.com/x')).toBe('generic');
  });

  it('falls back to generic for any other well-formed http(s) URL', () => {
    expect(detectProvider('https://bitbucket.org/a/b/pull-requests/1')).toBe('generic');
    expect(detectProvider('https://gitlab.example.com/a/b/-/issues/1')).toBe('generic');
    expect(detectProvider('http://example.com/doc')).toBe('generic');
  });

  it('returns null for empty or unparseable input', () => {
    expect(detectProvider('')).toBeNull();
    expect(detectProvider('   ')).toBeNull();
    expect(detectProvider('not a url')).toBeNull();
    expect(detectProvider('ftp://example.com/x')).toBeNull();
    expect(detectProvider('javascript:alert(1)')).toBeNull();
  });
});

describe('normalizeUrl (#970)', () => {
  it('keeps an explicit http(s) URL unchanged', () => {
    expect(normalizeUrl('https://github.com/a/b')).toBe('https://github.com/a/b');
    expect(normalizeUrl('http://example.com/x')).toBe('http://example.com/x');
  });

  it('prepends https:// to a bare host/path', () => {
    expect(normalizeUrl('github.com/acme/api/pull/5')).toBe('https://github.com/acme/api/pull/5');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('  example.com/doc  ')).toBe('https://example.com/doc');
  });

  it('rejects non-http(s) schemes and unparseable input', () => {
    expect(normalizeUrl('ftp://example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});
