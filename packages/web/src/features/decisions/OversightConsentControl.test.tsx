import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OversightConsentControl } from './OversightConsentControl';

const usePolicyMock = vi.hoisted(() => vi.fn());
const useSetPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useDecisions', () => ({
  useDecisionsPolicy: usePolicyMock,
  useSetDecisionsPolicy: useSetPolicyMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useSetPolicyMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe('OversightConsentControl', () => {
  it('renders nothing when the requester is not the consent authority', () => {
    usePolicyMock.mockReturnValue({ data: { oversight_visible: false, can_edit: false } });
    const { container } = render(<OversightConsentControl projectId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a switch reflecting the off posture for an admin', () => {
    usePolicyMock.mockReturnValue({ data: { oversight_visible: false, can_edit: true } });
    render(<OversightConsentControl projectId="p1" />);
    const sw = screen.getByRole('switch', { name: 'Oversight visibility' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/visible to the team and project managers only/)).toBeTruthy();
  });

  it('flips the switch via the set-policy mutation', () => {
    const mutate = vi.fn();
    useSetPolicyMock.mockReturnValue({ mutate, isPending: false });
    usePolicyMock.mockReturnValue({ data: { oversight_visible: false, can_edit: true } });
    render(<OversightConsentControl projectId="p1" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Oversight visibility' }));
    expect(mutate).toHaveBeenCalledWith({ projectId: 'p1', oversightVisible: true });
  });

  it('reflects the on posture and offers to turn it off', () => {
    usePolicyMock.mockReturnValue({ data: { oversight_visible: true, can_edit: true } });
    render(<OversightConsentControl projectId="p1" />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/oversight stakeholders can see/)).toBeTruthy();
  });
});
