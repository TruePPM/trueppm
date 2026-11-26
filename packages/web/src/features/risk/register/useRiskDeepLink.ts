import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { Risk } from '@/api/types';

/**
 * `?risk=<id>` deep-link ⇄ open-drawer round-trip (issue #2046). Opens the drawer
 * on the risk named by `?risk=`, both at mount and when the param changes while
 * the register stays mounted (the router keeps it mounted across search and
 * project changes, so a ⌘K reference lands here without a remount), and mirrors
 * the open risk's id back into the URL so a refresh or link-copy round-trips.
 *
 * `selectedRisk` follows the register's convention: `null` is closed,
 * `undefined` is create mode.
 */
export function useRiskDeepLink(
  risks: Risk[],
  selectedRisk: Risk | null | undefined,
  openRisk: (risk: Risk) => void,
  closeDrawer: () => void,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get('risk');
  const selectedRiskId = selectedRisk ? selectedRisk.id : null;

  // The param value already reconciled, the id still waiting for its register to
  // load, and the drawer id the URL last mirrored.
  const seenParamRef = useRef<string | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const mirroredIdRef = useRef<string | null>(null);

  // Drawer → URL. Keyed on the drawer id changing, not on the URL: `setSearchParams`
  // changes identity on every navigation, and rewriting then would overwrite an
  // incoming `?risk=` with the risk already open. Must stay declared before the
  // URL → drawer effect, which resets `mirroredIdRef` in the same commit.
  useEffect(() => {
    if (selectedRiskId === mirroredIdRef.current) return;
    mirroredIdRef.current = selectedRiskId;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selectedRiskId) next.set('risk', selectedRiskId);
        else next.delete('risk');
        return next;
      },
      { replace: true },
    );
  }, [selectedRiskId, setSearchParams]);

  // URL → drawer. A param equal to the open drawer is our own mirror write, and a
  // removed param is a close, so neither (re)opens anything.
  useEffect(() => {
    const changed = param !== seenParamRef.current;
    if (changed) {
      seenParamRef.current = param;
      pendingIdRef.current = param === selectedRiskId ? null : param;
    }
    const id = pendingIdRef.current;
    if (!id) return;
    const match = risks.find((r) => r.id === id);
    if (match) {
      pendingIdRef.current = null;
      openRisk(match);
      return;
    }
    // The URL now names another risk, so the open drawer is stale (typically
    // another project's). Close it once, without letting the mirror strip the
    // param we are still waiting on.
    if (changed && selectedRisk !== null) {
      mirroredIdRef.current = null;
      closeDrawer();
    }
    if (risks.length > 0) pendingIdRef.current = null; // loaded, and not in it
  }, [param, risks, selectedRisk, selectedRiskId, openRisk, closeDrawer]);
}
