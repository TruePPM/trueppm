import { describe, it, expect } from 'vitest';
import { HEALTH_BAND_LABEL, type HealthBand } from './healthBand';

describe('HEALTH_BAND_LABEL', () => {
  // The words are pinned as literals. This is the file that decides them, so an
  // assertion that read the map back would be a tautology — the point is that
  // changing a value here is a deliberate act that fails a test naming the old
  // word, not a silent edit (#3470).
  it('is the three-word health vocabulary of rule 7 / ADR-0126', () => {
    expect(HEALTH_BAND_LABEL).toEqual({
      on_track: 'On track',
      at_risk: 'At risk',
      critical: 'Critical',
    });
  });

  it('does not carry the retired "On watch" word for any band', () => {
    // The shell chip minted this as a fourth word for a three-value vocabulary
    // and it reached no other surface. `toEqual` above already fixes the map, but
    // this states the prohibition by name so a reintroduction fails a test that
    // says why rather than one that only says "not equal".
    expect(Object.values(HEALTH_BAND_LABEL)).not.toContain('On watch');
  });

  it('covers every band exactly once, with no empty word', () => {
    const bands: HealthBand[] = ['on_track', 'at_risk', 'critical'];
    expect(Object.keys(HEALTH_BAND_LABEL).sort()).toEqual([...bands].sort());
    for (const band of bands) expect(HEALTH_BAND_LABEL[band]).not.toHaveLength(0);
  });
});
