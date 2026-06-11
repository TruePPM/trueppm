import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { GuardrailHealthBadges } from './GuardrailHealthBadges';
import type { SprintHealth, SprintHealthSignal } from '@/hooks/useSprints';

const useSprintHealthMock = vi.fn<(projectId?: string | null) => { data?: SprintHealth }>();

vi.mock('@/hooks/useSprints', () => ({
  useSprintHealth: (projectId?: string | null) => useSprintHealthMock(projectId),
}));

function signal(overrides: Partial<SprintHealthSignal>): SprintHealthSignal {
  return {
    key: overrides.key ?? 'orphan',
    count: overrides.count ?? 1,
    tone: overrides.tone ?? 'info',
    detail: overrides.detail ?? 'detail',
  };
}

describe('GuardrailHealthBadges', () => {
  beforeEach(() => {
    useSprintHealthMock.mockReset();
  });

  it('renders nothing when the server returns no signals', () => {
    useSprintHealthMock.mockReturnValue({ data: { signals: [] } });
    const { container } = render(<GuardrailHealthBadges projectId="p-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the query is loading (no data)', () => {
    useSprintHealthMock.mockReturnValue({ data: undefined });
    const { container } = render(<GuardrailHealthBadges projectId="p-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the server `detail` copy verbatim, one badge per signal', () => {
    useSprintHealthMock.mockReturnValue({
      data: {
        signals: [
          signal({ key: 'orphan', tone: 'info', detail: '2 tasks in no sprint and no phase' }),
          signal({ key: 'phase_span', tone: 'info', detail: 'Active sprint spans 3 phases' }),
          signal({ key: 'summary_in_sprint', tone: 'warn', detail: '1 parent task in a sprint' }),
        ],
      },
    });
    render(<GuardrailHealthBadges projectId="p-1" />);
    // Verbatim server copy — the component never re-synthesizes these strings.
    expect(screen.getByText('2 tasks in no sprint and no phase')).toBeInTheDocument();
    expect(screen.getByText('Active sprint spans 3 phases')).toBeInTheDocument();
    expect(screen.getByText('1 parent task in a sprint')).toBeInTheDocument();
  });

  it('maps a warn-tone signal to the at-risk badge styling', () => {
    useSprintHealthMock.mockReturnValue({
      data: { signals: [signal({ key: 'summary_in_sprint', tone: 'warn', detail: '1 parent task in a sprint' })] },
    });
    render(<GuardrailHealthBadges projectId="p-1" />);
    const badge = screen.getByText('1 parent task in a sprint');
    expect(badge.className).toContain('text-semantic-at-risk');
  });

  it('maps an info-tone signal to the neutral badge styling', () => {
    useSprintHealthMock.mockReturnValue({
      data: { signals: [signal({ key: 'orphan', tone: 'info', detail: '2 tasks in no sprint and no phase' })] },
    });
    render(<GuardrailHealthBadges projectId="p-1" />);
    const badge = screen.getByText('2 tasks in no sprint and no phase');
    expect(badge.className).toContain('text-neutral-text-secondary');
  });
});
