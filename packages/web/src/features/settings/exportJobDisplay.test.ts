import { describe, expect, it } from 'vitest';
import { bundleButtonLabel, exportErrorText, exportStatusLabel } from './exportJobDisplay';

describe('exportStatusLabel', () => {
  it('shows "Queuing…" while the start request is in flight', () => {
    expect(exportStatusLabel(true, undefined)).toBe('Queuing…');
    // isQueuing wins even if a stale job status is present.
    expect(exportStatusLabel(true, 'running')).toBe('Queuing…');
  });

  it('maps job status to progress text', () => {
    expect(exportStatusLabel(false, 'pending')).toBe('Queued…');
    expect(exportStatusLabel(false, 'running')).toBe('Building bundle…');
  });

  it('returns null when idle or in a terminal state', () => {
    expect(exportStatusLabel(false, undefined)).toBeNull();
    expect(exportStatusLabel(false, 'success')).toBeNull();
    expect(exportStatusLabel(false, 'failed')).toBeNull();
  });
});

describe('bundleButtonLabel', () => {
  it('prefers Working… while busy', () => {
    expect(bundleButtonLabel(true, false, 'Export bundle…')).toBe('Working…');
    expect(bundleButtonLabel(true, true, 'Export bundle…')).toBe('Working…');
  });

  it('offers the download when ready and not busy', () => {
    expect(bundleButtonLabel(false, true, 'Export bundle…')).toBe('Download bundle');
  });

  it('falls back to the idle label', () => {
    expect(bundleButtonLabel(false, false, 'Export program bundle…')).toBe(
      'Export program bundle…',
    );
  });
});

describe('exportErrorText', () => {
  it('returns null when there is no error', () => {
    expect(
      exportErrorText({ downloadError: null, failed: false, startError: null }),
    ).toBeNull();
  });

  it('prefers the download error', () => {
    expect(
      exportErrorText({
        downloadError: 'Download failed — the link may have expired. Build a new bundle.',
        failed: true,
        errorDetail: 'boom',
        startError: 'start boom',
      }),
    ).toBe('Download failed — the link may have expired. Build a new bundle.');
  });

  it('formats a build failure with and without detail', () => {
    expect(
      exportErrorText({ downloadError: null, failed: true, startError: null }),
    ).toBe('Export failed. Try again.');
    expect(
      exportErrorText({ downloadError: null, failed: true, errorDetail: 'disk full', startError: null }),
    ).toBe('Export failed: disk full. Try again.');
  });

  it('falls back to the start error', () => {
    expect(
      exportErrorText({ downloadError: null, failed: false, startError: 'Could not queue export' }),
    ).toBe('Could not queue export');
  });
});
