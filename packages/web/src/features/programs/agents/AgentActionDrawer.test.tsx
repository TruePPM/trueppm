import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentAction } from '@/api/types';
import { AgentActionDrawer } from './AgentActionDrawer';

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
    engine_version: 'e3',
    payload_hash: 'payload-abc',
    record_hash: 'record-xyz',
    summary: '',
    occurred_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('AgentActionDrawer', () => {
  it('renders nothing when action is null', () => {
    const { container } = render(<AgentActionDrawer action={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the chain hashes verbatim and the resolved project/principal', () => {
    render(
      <AgentActionDrawer
        action={action()}
        projectName="Apollo"
        principalName="You"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Action #1274' })).toBeInTheDocument();
    expect(screen.getByText('record-xyz')).toBeInTheDocument();
    expect(screen.getByText('payload-abc')).toBeInTheDocument();
    expect(screen.getByText('Apollo')).toBeInTheDocument();
    expect(screen.getByText(/on behalf of You/)).toBeInTheDocument();
  });

  it('calls onClose on the close button and on Escape', () => {
    const onClose = vi.fn();
    render(<AgentActionDrawer action={action()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders the object row only when the action targets an object', () => {
    const { rerender } = render(<AgentActionDrawer action={action()} onClose={() => {}} />);
    expect(screen.queryByText('Object')).not.toBeInTheDocument();
    rerender(
      <AgentActionDrawer
        action={action({ object_type: 'Task', object_id: 't-9' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Object')).toBeInTheDocument();
    expect(screen.getByText(/Task/)).toBeInTheDocument();
  });

  it('traps focus, wrapping Tab from the last element to the first and vice versa', () => {
    render(<AgentActionDrawer action={action()} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Action #1274' });
    const focusable = dialog.querySelectorAll<HTMLElement>('button');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('copies a hash to the clipboard and flips the label to a checkmark', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AgentActionDrawer action={action()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy record_hash' }));
    expect(writeText).toHaveBeenCalledWith('record-xyz');
    expect(await screen.findByText('✓')).toBeInTheDocument();
  });
});
