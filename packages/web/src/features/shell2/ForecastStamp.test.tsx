import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloResult } from '@/types';
import { ForecastStamp } from './ContextHeader2';

/**
 * The context header's P80 stamp renders the SERVER's definition (ADR-1314, #4760).
 * It used to carry a sentence the web client wrote itself, which could describe the
 * number in words the server never used.
 */

const mc = vi.hoisted(() => ({ data: undefined as Partial<MonteCarloResult> | undefined }));
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => ({ data: mc.data, isLoading: false, error: null, refetch: vi.fn() }),
}));

describe('ForecastStamp', () => {
  beforeEach(() => {
    mc.data = undefined;
  });

  it('shows the server definition as the P80 tooltip', async () => {
    mc.data = {
      p80: '2026-06-05',
      lastRunAt: '2026-06-01T00:00:00Z',
      definitions: { p80: 'Server-written P80 sentence.' },
    };
    const user = userEvent.setup();
    render(<ForecastStamp projectId="p1" />);

    await user.hover(screen.getByRole('button', { name: 'P80' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Server-written P80 sentence.');
  });

  it('renders a plain label, not an empty tooltip, when the payload has no definitions', () => {
    mc.data = { p80: '2026-06-05' };
    render(<ForecastStamp projectId="p1" />);

    expect(screen.queryByRole('button', { name: 'P80' })).not.toBeInTheDocument();
    expect(screen.getByText('P80')).toBeInTheDocument();
  });

  it('renders nothing when there is no forecast', () => {
    const { container } = render(<ForecastStamp projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
