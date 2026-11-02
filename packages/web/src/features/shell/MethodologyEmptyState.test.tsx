import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarIcon } from '@/components/Icons';
import { renderWithRouter } from '@/test/utils';
import { MethodologyEmptyState } from './MethodologyEmptyState';

const accessMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAdminSettingsAccess', () => ({ useAdminSettingsAccess: accessMock }));

function renderIt() {
  return renderWithRouter(
    <MethodologyEmptyState
      projectId="proj-1"
      icon={CalendarIcon}
      title="Not how this team works"
      description="This project runs on phases and gates."
      adminHint="If sprints fit better here, switch the methodology in Settings."
      primaryLabel="Go to Schedule"
      primaryTo="/projects/proj-1/schedule"
    />,
  );
}

beforeEach(() => accessMock.mockReturnValue({ verdict: 'admin', refetch: () => {} }));
afterEach(() => vi.clearAllMocks());

describe('MethodologyEmptyState action visibility (#3528)', () => {
  it('shows the methodology action and the remedy sentence to an Admin', () => {
    renderIt();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
    expect(screen.getByText(/switch the methodology in Settings/)).toBeInTheDocument();
  });

  it.each(['not-admin', 'loading'])(
    'keeps the primary action and disclosure but drops the methodology action and remedy for %s',
    (verdict) => {
      accessMock.mockReturnValue({ verdict, refetch: () => {} });
      renderIt();
      expect(screen.getByRole('button', { name: 'Go to Schedule' })).toBeInTheDocument();
      expect(screen.getByText('This project runs on phases and gates.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Change methodology' })).not.toBeInTheDocument();
      expect(screen.queryByText(/switch the methodology/)).not.toBeInTheDocument();
    },
  );

  it('keeps the action when /auth/me failed, so an error cannot strand an Admin', () => {
    accessMock.mockReturnValue({ verdict: 'unknown', refetch: () => {} });
    renderIt();
    expect(screen.getByRole('button', { name: 'Change methodology' })).toBeInTheDocument();
  });
});
