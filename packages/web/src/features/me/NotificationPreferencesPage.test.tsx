import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationPreferencesPage } from './NotificationPreferencesPage';
import type { NotificationPreferenceRow } from '@/hooks/useNotificationPreferences';

const useNotificationPreferences = vi.fn();
const mutate = vi.fn();
const applyPresetMutate = vi.fn();
const useCurrentUser = vi.fn();

vi.mock('@/hooks/useNotificationPreferences', () => ({
  useNotificationPreferences: () => useNotificationPreferences() as unknown,
  useUpdateNotificationPreference: () => ({ mutate, isPending: false }),
  useApplyNotificationPreset: () => ({
    mutate: applyPresetMutate,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUser() as unknown,
}));

function pref(
  id: number,
  event_type: string,
  channel: string,
  enabled: boolean,
): NotificationPreferenceRow {
  return { id, event_type, channel, enabled, updated_at: '2026-05-24T00:00:00Z' };
}

// Includes the three #639 own-task events alongside the existing mentions.
const PREFERENCES: NotificationPreferenceRow[] = [
  pref(1, 'mention_individual', 'in_app', true),
  pref(2, 'mention_individual', 'email', false),
  pref(3, 'task.assigned', 'in_app', true),
  pref(4, 'task.assigned', 'email', false),
  pref(5, 'task.due_date_changed', 'in_app', true),
  pref(6, 'task.due_date_changed', 'email', false),
  pref(7, 'comment_on_my_task', 'in_app', true),
  pref(8, 'comment_on_my_task', 'email', false),
  // Stale-task daily nudge (ADR-0199, #646) — data-driven, renders from its pref rows.
  pref(9, 'task.stale', 'in_app', true),
  pref(10, 'task.stale', 'email', false),
];

function adminUser() {
  return { user: { can_access_admin_settings: true }, isLoading: false };
}
function contributorUser() {
  return { user: { can_access_admin_settings: false }, isLoading: false };
}

beforeEach(() => {
  useNotificationPreferences.mockReset();
  mutate.mockReset();
  applyPresetMutate.mockReset();
  useCurrentUser.mockReset();
  // Default to admin so the existing matrix tests see the full grid.
  useCurrentUser.mockReturnValue(adminUser());
});

describe('NotificationPreferencesPage', () => {
  it('renders friendly labels for the new own-task events', () => {
    useNotificationPreferences.mockReturnValue({
      preferences: PREFERENCES,
      isLoading: false,
      error: null,
    });
    render(<NotificationPreferencesPage />);
    // Desktop + mobile layouts both render in jsdom — use getAllByText.
    expect(screen.getAllByText('When a task is assigned to you').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('When the planned date of your task changes').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('When someone comments on your task').length).toBeGreaterThan(0);
    // Stale-task nudge (ADR-0199) renders its toggle row purely from its pref rows.
    expect(screen.getAllByText('When a task you own goes stale').length).toBeGreaterThan(0);
  });

  it('toggling a channel switch calls the update mutation (after debounce)', async () => {
    useNotificationPreferences.mockReturnValue({
      preferences: PREFERENCES,
      isLoading: false,
      error: null,
    });
    render(<NotificationPreferencesPage />);
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);
    fireEvent.click(switches[0]);
    // The page debounces the save (~300ms) — wait for the deferred mutate.
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('shows the Signal-only card to contributors and applies the preset on click (#855)', () => {
    useNotificationPreferences.mockReturnValue({
      preferences: PREFERENCES,
      isLoading: false,
      error: null,
    });
    useCurrentUser.mockReturnValue(contributorUser());
    render(<NotificationPreferencesPage />);
    expect(screen.getByText('Signal-only')).toBeInTheDocument();
    // Matrix is collapsed behind the escape until requested.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Use signal-only/i }));
    expect(applyPresetMutate).toHaveBeenCalledWith('signal_only', expect.anything());
    // The escape reveals the full matrix.
    fireEvent.click(screen.getByRole('button', { name: /Show all notification types/i }));
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
  });

  it('does NOT show the Signal-only card to admins — matrix renders directly', () => {
    useNotificationPreferences.mockReturnValue({
      preferences: PREFERENCES,
      isLoading: false,
      error: null,
    });
    useCurrentUser.mockReturnValue(adminUser());
    render(<NotificationPreferencesPage />);
    expect(screen.queryByText('Signal-only')).not.toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
  });
});
