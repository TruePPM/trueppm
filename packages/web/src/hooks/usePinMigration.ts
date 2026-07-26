/**
 * One-time migration of device-local pins to the server (#2390, ADR-0627).
 *
 * Before this change pins lived only in localStorage. After it the rail reads
 * `GET /auth/me/pinned/`, so a user whose pins never made it to the server would
 * open the app and find the Pinned group empty — the "my pins disappeared"
 * moment. This uploads them once per device.
 *
 * **UNION, never replace.** Server pins are authoritative and untouched; local
 * ids are added on top. Each POST is independently idempotent, so a partial run
 * resumes safely on the next load.
 *
 * The keys are cleared only on *full* success, and the sentinel is set only
 * then, so a failed or partial run retries rather than silently dropping pins.
 * They are retained through 0.6 rather than deleted in 0.5 so a device that has
 * been dormant for a release still migrates.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast';
import { PINNED_KEY } from './usePins';

const LEGACY_PROJECTS_KEY = 'trueppm.rail.pinned';
const LEGACY_PROGRAMS_KEY = 'trueppm.rail.pinnedPrograms';
const SENTINEL_KEY = 'trueppm.rail.pinsMigrated';

function readLegacyIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // A hand-edited or truncated value is not worth failing the app boot over.
    return [];
  }
}

export interface PinMigrationResult {
  /** Nothing to do — no legacy keys, or already migrated on this device. */
  skipped: boolean;
  migrated: number;
  /** True when at least one POST failed for a reason other than the cap. */
  failed: boolean;
  /** True when at least one POST was rejected by the per-user cap. */
  capped: boolean;
}

/**
 * Upload every locally-pinned id. Pure enough to unit-test: it takes its ids as
 * arguments and reports what happened rather than touching storage itself.
 */
export async function uploadLegacyPins(
  projectIds: string[],
  programIds: string[],
): Promise<PinMigrationResult> {
  let migrated = 0;
  let failed = false;
  let capped = false;

  const targets: { url: string }[] = [
    ...projectIds.map((id) => ({ url: `/projects/${id}/pin/` })),
    ...programIds.map((id) => ({ url: `/programs/${id}/pin/` })),
  ];

  for (const { url } of targets) {
    try {
      await apiClient.post(url);
      migrated += 1;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const code = (err as { response?: { data?: { code?: string } } }).response?.data?.code;
      if (status === 400 && code === 'pin_limit_reached') {
        capped = true;
        continue;
      }
      // 403/404 means the project was deleted or the user lost access — the pin
      // is genuinely stale, so treat it as migrated rather than retrying forever.
      if (status === 403 || status === 404) continue;
      failed = true;
    }
  }

  return { skipped: false, migrated, failed, capped };
}

/**
 * Mount once, high in the tree, after auth resolves.
 *
 * Success is deliberately invisible: nothing changes from the user's point of
 * view — their pins are still in the same rail under the same heading — and the
 * sentinel is per-device, so announcing it would re-announce the same non-event
 * on every browser they use.
 *
 * Failure is *not* invisible. The rail renders its error state (which is where
 * the absence is actually noticed), and the cap gets a toast because the rail
 * otherwise looks fine.
 */
export function usePinMigration(enabled: boolean): void {
  const qc = useQueryClient();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    if (localStorage.getItem(SENTINEL_KEY) === '1') return;

    const projectIds = readLegacyIds(LEGACY_PROJECTS_KEY);
    const programIds = readLegacyIds(LEGACY_PROGRAMS_KEY);
    if (projectIds.length === 0 && programIds.length === 0) {
      // Nothing to carry over — stamp the sentinel so we stop looking.
      localStorage.setItem(SENTINEL_KEY, '1');
      return;
    }

    startedRef.current = true;
    void (async () => {
      const result = await uploadLegacyPins(projectIds, programIds);
      if (!result.failed) {
        localStorage.setItem(SENTINEL_KEY, '1');
        localStorage.removeItem(LEGACY_PROJECTS_KEY);
        localStorage.removeItem(LEGACY_PROGRAMS_KEY);
      }
      if (result.capped) {
        toast.error("Some pins couldn't be moved — you're at the 100-pin limit.");
      }
      if (result.migrated > 0) {
        void qc.invalidateQueries({ queryKey: PINNED_KEY });
      }
    })();
  }, [enabled, qc]);
}
