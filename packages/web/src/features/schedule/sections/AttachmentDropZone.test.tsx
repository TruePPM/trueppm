/**
 * Tests for the client-side upload validator (#310 phase 2b).
 *
 * Mirrors the locked ADR-0075 constraints (#4 size cap, #5 MIME allow-list).
 * Server is the ultimate enforcement layer — these checks just avoid a
 * round-trip when the file is obviously bad.
 */

import { describe, expect, it } from 'vitest';
import { validateFileForUpload } from './AttachmentDropZone';

function makeFile(name: string, type: string, sizeBytes: number): File {
  // File() respects the given type; size from the blob bytes.
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe('validateFileForUpload — locked constraints', () => {
  it('accepts a PDF under the size cap', () => {
    const f = makeFile('rfi.pdf', 'application/pdf', 1024);
    expect(validateFileForUpload(f)).toBeNull();
  });

  it('rejects an unsupported MIME with a friendly message naming the file', () => {
    const f = makeFile('clip.mp4', 'video/mp4', 1024);
    const err = validateFileForUpload(f);
    expect(err).not.toBeNull();
    expect(err).toContain('clip.mp4');
    expect(err).toMatch(/not allowed/i);
  });

  it('rejects a file over 100 MB and reports its actual size', () => {
    const f = makeFile('huge.pdf', 'application/pdf', 101 * 1024 * 1024);
    const err = validateFileForUpload(f);
    expect(err).not.toBeNull();
    expect(err).toContain('huge.pdf');
    expect(err).toContain('100');
  });

  it('strips charset trailers from the MIME before checking the allow-list', () => {
    const f = makeFile('notes.csv', 'text/csv; charset=utf-8', 256);
    expect(validateFileForUpload(f)).toBeNull();
  });

  it('rejects a file with no MIME (unknown type)', () => {
    const f = makeFile('mystery', '', 256);
    const err = validateFileForUpload(f);
    expect(err).not.toBeNull();
    expect(err).toMatch(/unknown type|not allowed/i);
  });

  it('accepts each allow-list MIME', () => {
    const allowList: { name: string; mime: string }[] = [
      { name: 'doc.pdf', mime: 'application/pdf' },
      { name: 'pic.jpg', mime: 'image/jpeg' },
      { name: 'pic.png', mime: 'image/png' },
      { name: 'pic.webp', mime: 'image/webp' },
      {
        name: 'sheet.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { name: 'data.csv', mime: 'text/csv' },
      {
        name: 'doc.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ];
    for (const f of allowList) {
      const file = makeFile(f.name, f.mime, 1024);
      expect(validateFileForUpload(file)).toBeNull();
    }
  });
});
