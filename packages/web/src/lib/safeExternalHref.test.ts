import { describe, expect, it } from 'vitest';
import { safeExternalHref } from './safeExternalHref';

describe('safeExternalHref', () => {
  it('returns the URL for well-formed http and https links', () => {
    expect(safeExternalHref('https://example.com/doc')).toBe('https://example.com/doc');
    expect(safeExternalHref('http://example.com/doc')).toBe('http://example.com/doc');
    expect(safeExternalHref('https://gitlab.com/acme/api/-/merge_requests/5')).toBe(
      'https://gitlab.com/acme/api/-/merge_requests/5',
    );
  });

  it('returns null for a javascript: URL (stored XSS vector)', () => {
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    // Case-insensitive scheme — the URL parser normalizes the protocol.
    expect(safeExternalHref('JavaScript:alert(1)')).toBeNull();
  });

  it('returns null for a data: URL', () => {
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('returns null for other non-http(s) schemes', () => {
    expect(safeExternalHref('ftp://example.com/x')).toBeNull();
    expect(safeExternalHref('file:///etc/passwd')).toBeNull();
    expect(safeExternalHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('returns null for malformed or empty input', () => {
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref('   ')).toBeNull();
    expect(safeExternalHref('not a url')).toBeNull();
    expect(safeExternalHref('example.com/no-scheme')).toBeNull();
  });
});
