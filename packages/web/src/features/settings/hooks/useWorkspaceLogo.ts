import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { WorkspaceSettings } from '@/api/types';

/** Raster types the server accepts (ADR-0149). SVG is rejected (stored-XSS). */
export const LOGO_ACCEPTED_TYPES = ['image/png', 'image/webp'] as const;
export const LOGO_ACCEPT_ATTR = LOGO_ACCEPTED_TYPES.join(',');
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — mirrors the server cap.
/** Advisory minimum; the server does not enforce it (no Pillow), so this is a
 *  soft warning the user can override, not a hard block. */
export const LOGO_MIN_DIMENSION = 256;

export type LogoValidationLevel = 'error' | 'warning';

export interface LogoValidationResult {
  level: LogoValidationLevel;
  message: string;
}

/**
 * Client-side pre-flight on a chosen logo file (ADR-0149).
 *
 * Returns an `error` (block the upload) for wrong type or oversize, a `warning`
 * (allow but advise) for under-minimum dimensions, or null when the file is fine.
 * Dimension checks are async because they require decoding the image; type/size
 * are validated synchronously first so an obviously-bad file fails fast.
 */
export async function validateLogoFile(file: File): Promise<LogoValidationResult | null> {
  if (!LOGO_ACCEPTED_TYPES.includes(file.type as (typeof LOGO_ACCEPTED_TYPES)[number])) {
    return { level: 'error', message: 'PNG or WebP only.' };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { level: 'error', message: 'Logo must be 2 MB or smaller.' };
  }
  const dims = await readImageDimensions(file).catch(() => null);
  if (dims && (dims.width < LOGO_MIN_DIMENSION || dims.height < LOGO_MIN_DIMENSION)) {
    return {
      level: 'warning',
      message: `Recommended at least ${LOGO_MIN_DIMENSION}×${LOGO_MIN_DIMENSION}px — this image may look soft.`,
    };
  }
  return null;
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const result = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image.'));
    };
    img.src = url;
  });
}

export function useUploadWorkspaceLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const res = await apiClient.post<WorkspaceSettings>('/workspace/logo/', body, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 0,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
    },
  });
}

export function useDeleteWorkspaceLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.delete('/workspace/logo/');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
    },
  });
}
