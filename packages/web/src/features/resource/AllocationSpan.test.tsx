/**
 * Unit tests for AllocationSpan — covers the 'partial' variant's diagonal
 * stripe overlay, which moved off a hardcoded rgba(0,0,0,…) fill onto the
 * mode-aware --allocation-partial-stripe token (issue #1914).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AllocationSpan } from './AllocationSpan';
import { partialAllocationStripeStyle } from './resourceUtils';
import type { AllocationTask } from './resourceUtils';

function makeTask(overrides: Partial<AllocationTask> = {}): AllocationTask {
  return {
    assignment_id: 'assign-1',
    id: 'task-1',
    name: 'Draft SOW',
    early_start: '2026-04-01',
    early_finish: '2026-04-10',
    units: '0.50',
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

function renderSpan(
  variant: 'normal' | 'partial' | 'over' | 'complete',
  overrides: Partial<AllocationTask> = {},
) {
  return render(
    <AllocationSpan
      task={makeTask(overrides)}
      variant={variant}
      leftFraction={0.1}
      widthFraction={0.3}
      containerWidth={600}
      onEdit={vi.fn()}
    />,
  );
}

describe('AllocationSpan — partial-allocation stripe (#1914)', () => {
  it('applies the mode-aware --allocation-partial-stripe token for the partial variant', () => {
    renderSpan('partial');
    const btn = screen.getByRole('button');
    expect(btn.style.backgroundImage).toContain('var(--allocation-partial-stripe)');
    expect(btn.style.backgroundImage).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });

  it('matches the shared partialAllocationStripeStyle("span") helper output', () => {
    renderSpan('partial');
    const btn = screen.getByRole('button');
    expect(btn.style.backgroundImage).toBe(partialAllocationStripeStyle('span').backgroundImage);
  });

  it('does not apply the stripe overlay for the normal variant', () => {
    renderSpan('normal');
    const btn = screen.getByRole('button');
    expect(btn.style.backgroundImage).toBe('');
  });
});
