import { describe, expect, it } from 'vitest';
import { HEALTH_BAND_LABEL } from '@/lib/healthBand';
import { RAGS, RAG_BAND, asHealthBand, ragLabel } from './ragBand';

describe('ragBand', () => {
  it('prints every call with the band word from the one vocabulary', () => {
    for (const rag of RAGS) expect(ragLabel(rag)).toBe(HEALTH_BAND_LABEL[RAG_BAND[rag]]);
    expect(RAGS).toEqual(['green', 'amber', 'red']);
  });

  it('narrows only real bands', () => {
    expect(asHealthBand('at_risk')).toBe('at_risk');
    expect(asHealthBand('unknown')).toBeNull();
    expect(asHealthBand(null)).toBeNull();
  });
});
