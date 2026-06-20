import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LOGO_ACCEPT_ATTR,
  LOGO_MAX_BYTES,
  validateLogoFile,
} from './useWorkspaceLogo';

/** Build a File with a controllable `size` (jsdom doesn't size from content). */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('useWorkspaceLogo — validateLogoFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the PNG and WebP MIME types in the file-picker accept attribute', () => {
    expect(LOGO_ACCEPT_ATTR).toBe('image/png,image/webp');
  });

  it('rejects a non-raster type with a blocking error', async () => {
    const result = await validateLogoFile(fakeFile('logo.svg', 'image/svg+xml', 1000));
    expect(result).toEqual({ level: 'error', message: 'PNG or WebP only.' });
  });

  it('rejects an oversize file with a blocking error', async () => {
    const result = await validateLogoFile(
      fakeFile('big.png', 'image/png', LOGO_MAX_BYTES + 1),
    );
    expect(result?.level).toBe('error');
    expect(result?.message).toMatch(/2 MB/);
  });

  it('warns (but does not block) when the image is under 256×256', async () => {
    stubImageDimensions(120, 120);
    const result = await validateLogoFile(fakeFile('small.png', 'image/png', 1000));
    expect(result?.level).toBe('warning');
    expect(result?.message).toMatch(/256/);
  });

  it('returns null for a valid, large-enough PNG', async () => {
    stubImageDimensions(512, 512);
    const result = await validateLogoFile(fakeFile('ok.png', 'image/png', 1000));
    expect(result).toBeNull();
  });
});

/**
 * Stub the Image decode path so dimension checks are deterministic without a real
 * raster decoder (jsdom has none). Fires `onload` with the given natural size.
 */
function stubImageDimensions(width: number, height: number): void {
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: () => undefined,
  });
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = width;
    naturalHeight = height;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', StubImage);
}
