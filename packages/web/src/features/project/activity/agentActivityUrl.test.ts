import { describe, expect, it } from 'vitest';
import {
  agentParams,
  agentRangeFromParams,
  DEFAULT_AGENT_RANGE,
  refusalsOnlyFromParams,
  subViewFromParams,
} from './agentActivityUrl';

describe('subViewFromParams', () => {
  it('defaults to changes when the param is absent', () => {
    expect(subViewFromParams(new URLSearchParams())).toBe('changes');
  });

  it('reads the agents sub-view', () => {
    expect(subViewFromParams(new URLSearchParams('view=agents'))).toBe('agents');
  });

  it('falls back to changes for an unknown token rather than rendering nothing', () => {
    expect(subViewFromParams(new URLSearchParams('view=bogus'))).toBe('changes');
  });

  it('leaves a pre-#2481 changelog deep-link on the Changes sub-view', () => {
    // The regression that matters: every Activity link written before the split
    // carries changelog filters and no `view`, and must resolve exactly as before.
    const legacy = new URLSearchParams('type=task&change=updated&user=u1&range=7d');
    expect(subViewFromParams(legacy)).toBe('changes');
  });
});

describe('refusalsOnlyFromParams', () => {
  it('is off by default', () => {
    expect(refusalsOnlyFromParams(new URLSearchParams('view=agents'))).toBe(false);
  });

  it('is on for refused=1', () => {
    expect(refusalsOnlyFromParams(new URLSearchParams('view=agents&refused=1'))).toBe(true);
  });

  it('treats any other value as off', () => {
    expect(refusalsOnlyFromParams(new URLSearchParams('refused=true'))).toBe(false);
  });
});

describe('agentRangeFromParams', () => {
  it('defaults to 7d', () => {
    expect(agentRangeFromParams(new URLSearchParams())).toBe(DEFAULT_AGENT_RANGE);
    expect(DEFAULT_AGENT_RANGE).toBe('7d');
  });

  it('reads a known range', () => {
    expect(agentRangeFromParams(new URLSearchParams('arange=30d'))).toBe('30d');
    expect(agentRangeFromParams(new URLSearchParams('arange=all'))).toBe('all');
  });

  it('falls back to the default for an unknown range', () => {
    expect(agentRangeFromParams(new URLSearchParams('arange=99y'))).toBe('7d');
  });

  it('does not read the changelog range param', () => {
    // `range` belongs to the changelog; the agent window is `arange`. Sharing one
    // key would make a changelog filter silently retune the agent query.
    expect(agentRangeFromParams(new URLSearchParams('range=24h'))).toBe('7d');
  });
});

describe('agentParams', () => {
  it('emits only the view param at defaults, so a shared link stays clean', () => {
    expect(agentParams({ refusalsOnly: false, range: '7d' }).toString()).toBe('view=agents');
  });

  it('emits refused and arange only when they differ from the default', () => {
    const params = agentParams({ refusalsOnly: true, range: '30d' });
    expect(params.get('view')).toBe('agents');
    expect(params.get('refused')).toBe('1');
    expect(params.get('arange')).toBe('30d');
  });

  it('round-trips through the readers', () => {
    const params = agentParams({ refusalsOnly: true, range: 'all' });
    expect(subViewFromParams(params)).toBe('agents');
    expect(refusalsOnlyFromParams(params)).toBe(true);
    expect(agentRangeFromParams(params)).toBe('all');
  });

  it('drops the changelog filters rather than carrying invisible narrowing', () => {
    // Switching to Agents must not leave `type=task` applied under controls that
    // no longer render it (ADR-0677).
    const params = agentParams({ refusalsOnly: false, range: '7d' });
    expect(params.get('type')).toBeNull();
    expect(params.get('change')).toBeNull();
    expect(params.get('user')).toBeNull();
    expect(params.get('range')).toBeNull();
  });
});
