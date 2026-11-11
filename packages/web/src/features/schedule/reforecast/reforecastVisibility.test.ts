import { describe, expect, it } from 'vitest';
import { reforecastPanelVisible } from './reforecastVisibility';

describe('reforecastPanelVisible (#3158)', () => {
  it('is visible until dismissed', () => {
    expect(reforecastPanelVisible(null, null)).toBe(true);
    expect(reforecastPanelVisible(null, { count: 600, since: 5 })).toBe(true);
  });

  it('stays hidden after a dismiss when nothing new is truncated', () => {
    expect(reforecastPanelVisible(100, null)).toBe(false);
    // The run the planner already dismissed does not re-open it.
    expect(reforecastPanelVisible(100, { count: 600, since: 50 })).toBe(false);
  });

  it('re-opens for a truncated run that arrives after the dismiss', () => {
    expect(reforecastPanelVisible(100, { count: 600, since: 101 })).toBe(true);
  });
});
