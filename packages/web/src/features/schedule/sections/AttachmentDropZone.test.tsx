/**
 * Tests for the client-side upload validator (#310 phase 2b).
 *
 * Mirrors the locked ADR-0075 constraints (#4 size cap, #5 MIME allow-list).
 * Server is the ultimate enforcement layer — these checks just avoid a
 * round-trip when the file is obviously bad.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AttachmentDropZone, validateFileForUpload } from './AttachmentDropZone';

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

describe('AttachmentDropZone — drop interactions', () => {
  it('emits onFile for each valid dropped file', () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <AttachmentDropZone onFile={onFile} onError={onError} alwaysVisible />,
    );
    const zone = container.firstChild as HTMLElement;
    const file = makeFile('a.pdf', 'application/pdf', 100);
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(onError).not.toHaveBeenCalled();
  });

  it('emits onError for invalid files and never calls onFile for them', () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <AttachmentDropZone onFile={onFile} onError={onError} alwaysVisible />,
    );
    const zone = container.firstChild as HTMLElement;
    const bad = makeFile('clip.mp4', 'video/mp4', 100);
    fireEvent.drop(zone, { dataTransfer: { files: [bad] } });
    expect(onError).toHaveBeenCalled();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('ignores drag/drop entirely when disabled', () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <AttachmentDropZone onFile={onFile} onError={onError} alwaysVisible disabled />,
    );
    const zone = container.firstChild as HTMLElement;
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, {
      dataTransfer: { files: [makeFile('a.pdf', 'application/pdf', 100)] },
    });
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('toggles dragOver styling on drag over and leave', () => {
    const { container } = render(
      <AttachmentDropZone onFile={vi.fn()} onError={vi.fn()} alwaysVisible={false} />,
    );
    const zone = container.firstChild as HTMLElement;
    expect(zone.getAttribute('aria-hidden')).toBe('true');
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('aria-hidden')).toBe('false');
    fireEvent.dragLeave(zone);
    expect(zone.getAttribute('aria-hidden')).toBe('true');
  });
});
