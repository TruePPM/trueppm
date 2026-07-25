import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { Risk } from '@/api/types';

/**
 * `?risk=<id>` deep-link ⇄ open-drawer round-trip (issue #2046). On mount, opens
 * the drawer on the risk named by the initial `?risk=` param once the register
 * loads; thereafter mirrors the open risk's id back into the URL so a refresh or
 * link-copy round-trips. Extracted from the register component to keep the
 * consume/mirror effects (and their branching) out of its body — behavior is
 * unchanged.
 */
export function useRiskDeepLink(
  risks: Risk[],
  selectedRisk: Risk | null | undefined,
  setSelectedRisk: (risk: Risk) => void,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialRiskParamRef = useRef(searchParams.get('risk'));
  const riskParamConsumedRef = useRef(false);

  useEffect(() => {
    if (riskParamConsumedRef.current) return;
    const id = initialRiskParamRef.current;
    if (!id) {
      riskParamConsumedRef.current = true;
      return;
    }
    if (risks.length === 0) return; // register not loaded yet — retry next render
    const match = risks.find((r) => r.id === id);
    riskParamConsumedRef.current = true;
    if (match) setSelectedRisk(match);
  }, [risks, setSelectedRisk]);

  const selectedRiskId = selectedRisk ? selectedRisk.id : null;
  useEffect(() => {
    if (!riskParamConsumedRef.current) return;
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
}
