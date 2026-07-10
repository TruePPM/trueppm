import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GuardrailBlock } from './GuardrailBlock';

const DETAIL =
  'This phase rolls up its child tasks — assign the child tasks instead.';

describe('GuardrailBlock', () => {
  it('uses role=alert (must act), not status', () => {
    render(<GuardrailBlock detail={DETAIL} onDismiss={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the outcome-language detail and offers only acknowledge (no override)', () => {
    render(<GuardrailBlock detail={DETAIL} onDismiss={vi.fn()} />);
    expect(screen.getByText(/assign the child tasks instead/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep it here' })).not.toBeInTheDocument();
  });

  it('calls onDismiss when acknowledged', () => {
    const onDismiss = vi.fn();
    render(<GuardrailBlock detail={DETAIL} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // Rule 228 / WCAG 2.5.5 (#1801): the acknowledge button keeps the 44px touch
  // floor on phones, compacting only at `md:`. Regression guarded: compaction
  // keyed off `sm:` (fires at 375px) dropped the target to 32px.
  it('the acknowledge button keeps a 44px touch floor, compacting only at md:', () => {
    render(<GuardrailBlock detail={DETAIL} onDismiss={vi.fn()} />);
    const cls = screen.getByRole('button', { name: 'Got it' }).className;
    expect(cls).toContain('min-h-[44px]');
    expect(cls).toContain('md:min-h-0');
    expect(cls).not.toContain('sm:min-h-0');
  });
});
