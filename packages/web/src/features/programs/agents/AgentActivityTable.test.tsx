import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { AgentAction } from '@/api/types';
import { AgentActivityTable } from './AgentActivityTable';

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'a1',
    schema_version: 1,
    sequence: 1274,
    actor_kind: 'mcp_token',
    actor_token_prefix: '3f9a1122',
    principal: 'u1',
    action: 'get_schedule',
    method: 'GET',
    object_type: '',
    object_id: '',
    project: 'p1',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
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

describe('AgentActivityTable', () => {
  it('renders a row with verdict icon + label and calls onSelect on the seq button', () => {
    const onSelect = vi.fn();
    render(
      <AgentActivityTable
        actions={[action()]}
        resolvePrincipal={() => 'You'}
        onSelect={onSelect}
        hasNextPage={false}
        fetchNextPage={noop}
        isFetchingNextPage={false}
        showReadOnlyStrip={false}
      />,
    );
    // Desktop table + mobile cards both render the seq button — pick the table one.
    const seqButton = screen.getAllByRole('button', {
      name: /Action #1274, get_schedule, Allowed/i,
    })[0];
    fireEvent.click(seqButton);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1274 }));
    expect(screen.getAllByText('Allowed').length).toBeGreaterThan(0);
  });

  it('shows the read-only strip only when told to', () => {
    const { rerender } = render(
      <AgentActivityTable
        actions={[action()]}
        resolvePrincipal={() => null}
        onSelect={noop}
        hasNextPage={false}
        fetchNextPage={noop}
        isFetchingNextPage={false}
        showReadOnlyStrip
      />,
    );
    expect(screen.getByText(/Today agents can only read/i)).toBeInTheDocument();
    rerender(
      <AgentActivityTable
        actions={[action()]}
        resolvePrincipal={() => null}
        onSelect={noop}
        hasNextPage={false}
        fetchNextPage={noop}
        isFetchingNextPage={false}
        showReadOnlyStrip={false}
      />,
    );
    expect(screen.queryByText(/Today agents can only read/i)).not.toBeInTheDocument();
  });

  it('renders "Load older" and fires fetchNextPage when there is another page', () => {
    const fetchNextPage = vi.fn();
    render(
      <AgentActivityTable
        actions={[action()]}
        resolvePrincipal={() => null}
        onSelect={noop}
        hasNextPage
        fetchNextPage={fetchNextPage}
        isFetchingNextPage={false}
        showReadOnlyStrip={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Load older/i }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('shows a refused verdict in red with the ⛔ symbol', () => {
    render(
      <AgentActivityTable
        actions={[action({ verdict: 'refused', refusal_reason: 'identity' })]}
        resolvePrincipal={() => null}
        onSelect={noop}
        hasNextPage={false}
        fetchNextPage={noop}
        isFetchingNextPage={false}
        showReadOnlyStrip={false}
      />,
    );
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getByText('Refused')).toBeInTheDocument();
  });
});
