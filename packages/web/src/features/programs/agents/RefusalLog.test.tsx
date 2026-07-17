import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentAction } from '@/api/types';
import { RefusalLog } from './RefusalLog';

function refusal(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: Math.random().toString(36).slice(2),
    schema_version: 1,
    sequence: 1,
    actor_kind: 'mcp_token',
    actor_token_prefix: 'a10c9988',
    principal: null,
    action: 'get_forecast',
    method: 'GET',
    object_type: '',
    object_id: '',
    project: 'p1',
    capability_used: 'mcp:read',
    verdict: 'refused',
    refusal_reason: 'identity',
    refusal_detail: null,
    engine_version: 'e',
    payload_hash: 'ph',
    record_hash: 'rh',
    summary: '',
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

const noop = () => {};
const base = {
  resolvePrincipal: () => null,
  onSelect: noop,
  hasNextPage: false,
  fetchNextPage: noop,
  isFetchingNextPage: false,
};

describe('RefusalLog', () => {
  it('counts the identity/policy distribution and always labels the commitment bucket', () => {
    render(
      <RefusalLog
        refusals={[
          refusal({ refusal_reason: 'identity' }),
          refusal({ refusal_reason: 'policy' }),
          refusal({ refusal_reason: 'policy' }),
        ]}
        {...base}
      />,
    );
    // The distribution header restates the counts.
    const dist = screen.getByRole('img', { name: /Refusal reasons/i });
    expect(dist).toHaveAttribute(
      'aria-label',
      expect.stringContaining('1 identity, 2 policy, 0 commitment'),
    );
  });

  it('renders each refusal with its reason and a literal why-string', () => {
    render(<RefusalLog refusals={[refusal({ refusal_reason: 'policy' })]} {...base} />);
    expect(screen.getByText(/Missing mcp:read scope/i)).toBeInTheDocument();
  });

  it('always shows the forward-looking commitment section (0.6)', () => {
    render(<RefusalLog refusals={[]} {...base} />);
    expect(screen.getByText(/arrives with 0.6 writes/i)).toBeInTheDocument();
    expect(screen.getByText(/No refusals in this range/i)).toBeInTheDocument();
  });

  it('calls onSelect when a refusal row is activated', () => {
    const onSelect = vi.fn();
    render(<RefusalLog refusals={[refusal({ sequence: 42 })]} {...base} onSelect={onSelect} />);
    screen.getByRole('button', { name: /Refused action #42/i }).click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sequence: 42 }));
  });
});
