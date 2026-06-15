import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MyGeneralPreferencesPage } from './MyGeneralPreferencesPage';

interface MutateOpts {
  onSuccess?: () => void;
  onError?: () => void;
}

const useCurrentUser = vi.fn();
const mutate = vi.fn<(value: unknown, opts?: MutateOpts) => void>();
let mutationState = { isPending: false, isError: false };

vi.mock('@/hooks/useCurrentUser', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useCurrentUser')>('@/hooks/useCurrentUser');
  return { ...actual, useCurrentUser: () => useCurrentUser() as unknown };
});

vi.mock('@/hooks/useDefaultLanding', () => ({
  useUpdateDefaultLanding: () => ({ mutate, ...mutationState }),
}));

vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

function userWith(defaultLanding: string, intent = 'project_overview') {
  return {
    user: {
      id: 'u1',
      default_landing: defaultLanding,
      landing: { intent, path: '/me/work', resolved_by: 'role_policy' },
    },
    isLoading: false,
  };
}

beforeEach(() => {
  mutate.mockReset();
  mutationState = { isPending: false, isError: false };
  useCurrentUser.mockReset();
  useCurrentUser.mockReturnValue(userWith('auto'));
});

describe('MyGeneralPreferencesPage (ADR-0129, #1181)', () => {
  it('renders the Preferences heading and the default-landing section', () => {
    renderWithRouter(<MyGeneralPreferencesPage />);
    expect(screen.getByRole('heading', { name: 'Preferences', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Default landing screen' })).toBeInTheDocument();
  });

  it('pre-selects Auto when it is the stored default', () => {
    renderWithRouter(<MyGeneralPreferencesPage />);
    expect(screen.getByRole('radio', { name: /Auto \(recommended\)/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it("Auto's helper echoes the live resolved intent while default is auto", () => {
    useCurrentUser.mockReturnValue(userWith('auto', 'project_overview'));
    renderWithRouter(<MyGeneralPreferencesPage />);
    expect(screen.getByText(/Right now this opens a project's Overview/i)).toBeInTheDocument();
  });

  it("Auto's helper changes when a concrete preference is set", () => {
    useCurrentUser.mockReturnValue(userWith('my_work'));
    renderWithRouter(<MyGeneralPreferencesPage />);
    expect(screen.getByText(/Picks the best screen based on your role/i)).toBeInTheDocument();
  });

  it('selecting an option PATCHes immediately (auto-save) and announces Saved.', () => {
    // onSuccess runs synchronously, so the PATCH and the "Saved." line are
    // observable right after the click.
    mutate.mockImplementation((_value: unknown, opts?: MutateOpts) => opts?.onSuccess?.());
    renderWithRouter(<MyGeneralPreferencesPage />);
    fireEvent.click(screen.getByRole('radio', { name: /My Work/i }));
    expect(mutate).toHaveBeenCalledWith('my_work', expect.any(Object));
    expect(screen.getByText('Saved.', { selector: '[aria-live]' })).toBeInTheDocument();
  });

  it('reverts the optimistic selection and shows an error on failure', () => {
    mutationState = { isPending: false, isError: true };
    mutate.mockImplementation((_value: unknown, opts?: MutateOpts) => opts?.onError?.());
    renderWithRouter(<MyGeneralPreferencesPage />);
    fireEvent.click(screen.getByRole('radio', { name: /My Work/i }));
    // Reverted back to Auto.
    expect(screen.getByRole('radio', { name: /Auto \(recommended\)/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/Couldn't save preference/i)).toBeInTheDocument();
  });

  it('blocks the PATCH while offline and shows the offline note', () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderWithRouter(<MyGeneralPreferencesPage />);
    expect(screen.getByText(/reconnect to change your home screen/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /My Work/i }));
    expect(mutate).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
