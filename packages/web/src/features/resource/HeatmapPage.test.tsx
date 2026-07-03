/**
 * Unit tests for the HeatmapPage `resources_heatmap.level_loads` extension slot.
 *
 * Adoption-first (issue 1614): when no Enterprise override is registered — the
 * state of every OSS install — the slot must render nothing. A permanently
 * disabled "Level loads" teaser button is forbidden. When Enterprise registers
 * an override, its component renders in place.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeatmapPage } from './HeatmapPage';
import { registry } from '@/lib/widget-registry';

// Neutralize data hooks so the header (which hosts the slot) renders without
// network or router context. The slot behavior is independent of load state.
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'project-1' }));
vi.mock('@/hooks/useTriggerScheduler', () => ({
  useTriggerScheduler: () => vi.fn(),
}));
vi.mock('@/hooks/useResourceHeatmap', () => ({
  useResourceHeatmap: () => ({ data: undefined, status: 'loading', error: null }),
}));
vi.mock('@/hooks/useResourceSummary', () => ({
  useResourceSummary: () => ({ data: undefined, status: 'loading', error: null }),
}));

const SLOT = 'resources_heatmap.level_loads';

afterEach(() => {
  // The registry is a shared singleton; drop any override registered by a test.
  registry.get(SLOT).length = 0;
});

describe('HeatmapPage — level_loads extension slot', () => {
  it('renders no "Level loads" control when the slot has no override (OSS)', () => {
    render(<HeatmapPage />);
    expect(
      screen.queryByRole('button', { name: /Level loads/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the Enterprise component when an override is registered', () => {
    registry.register(SLOT, {
      id: 'enterprise-level-loads',
      priority: 0,
      component: () => <button type="button">⚡ Level loads</button>,
    });
    render(<HeatmapPage />);
    expect(
      screen.getByRole('button', { name: /Level loads/i }),
    ).toBeInTheDocument();
  });
});
