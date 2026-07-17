import { describe, it, expect } from 'vitest';
import type { AgentAction } from '@/api/types';
import { VERDICT_DISPLAY, refusalGroup, refusalWhy } from './agentDisplay';

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'a1',
    schema_version: 1,
    sequence: 1,
    actor_kind: 'mcp_token',
    actor_token_prefix: '3f9a1122',
    principal: 'u1',
    action: 'list_tasks',
    method: 'GET',
    object_type: '',
    object_id: '',
    project: 'p1',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
    refusal_detail: null,
    engine_version: 'trueppm-scheduler 0.4.1',
    payload_hash: 'c7e2',
    record_hash: '9f2c',
    summary: '',
    occurred_at: '2026-07-12T14:03:11Z',
    ...overrides,
  };
}

describe('agentDisplay', () => {
  it('maps every verdict to an icon + text label + color (never color-alone)', () => {
    for (const v of ['allowed', 'refused', 'requires_approval'] as const) {
      const d = VERDICT_DISPLAY[v];
      expect(d.label).toBeTruthy();
      expect(d.symbol).toBeTruthy();
      expect(d.textClass).toMatch(/semantic-/);
    }
  });

  it('buckets an identity refusal as identity and a policy refusal as policy', () => {
    expect(refusalGroup(action({ verdict: 'refused', refusal_reason: 'identity' }))).toBe(
      'identity',
    );
    expect(refusalGroup(action({ verdict: 'refused', refusal_reason: 'policy' }))).toBe('policy');
  });

  it('derives a literal why-string from the recorded reason', () => {
    expect(refusalWhy(action({ refusal_reason: 'identity' }))).toMatch(/invalid or expired/i);
    expect(refusalWhy(action({ refusal_reason: 'policy', capability_used: 'mcp:read' }))).toMatch(
      /mcp:read/,
    );
  });
});
