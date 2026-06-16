import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LandingPrimaryUsePrompt } from './LandingPrimaryUsePrompt';
import { LANDING_PROMPT_SEEN_KEY } from './landing';

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

// The shared radio group renders an EnterpriseBadge for the gated Portfolio
// option, which reads useEdition — keep it community so the gate applies.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

function autoUser(intent = 'project_overview') {
  return {
    user: {
      id: 'u1',
      default_landing: 'auto',
      landing: { intent, path: '/me/work', resolved_by: 'role_policy' },
    },
    isLoading: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  mutate.mockReset();
  mutationState = { isPending: false, isError: false };
  useCurrentUser.mockReset();
  useCurrentUser.mockReturnValue(autoUser());
});

afterEach(() => {
  localStorage.clear();
});

describe('LandingPrimaryUsePrompt (ADR-0129, #1181)', () => {
  it('shows when default_landing is auto and the prompt has not been seen', () => {
    render(<LandingPrimaryUsePrompt />);
    expect(
      screen.getByRole('heading', { name: /Where do you want TruePPM to open/i }),
    ).toBeInTheDocument();
  });

  it('does not show when a concrete preference is already set', () => {
    useCurrentUser.mockReturnValue({
      user: {
        id: 'u1',
        default_landing: 'my_work',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
        hidden_views: [],
      },
      isLoading: false,
    });
    const { container } = render(<LandingPrimaryUsePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not show when the seen flag is already set', () => {
    localStorage.setItem(LANDING_PROMPT_SEEN_KEY, '1');
    const { container } = render(<LandingPrimaryUsePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('echoes the live resolved intent in the Auto option', () => {
    useCurrentUser.mockReturnValue(autoUser('project_overview'));
    render(<LandingPrimaryUsePrompt />);
    // The echo text is split across nodes (label + interpolated intent), so
    // match the surrounding copy and the intent label independently.
    expect(screen.getByText(/currently opens/i)).toBeInTheDocument();
    // "A project's Overview" appears both as a radio-card label and in the echo.
    expect(screen.getAllByText(/a project's Overview/i).length).toBeGreaterThanOrEqual(1);
  });

  it('Skip sets the seen flag and hides the card, with no PATCH', () => {
    render(<LandingPrimaryUsePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(localStorage.getItem(LANDING_PROMPT_SEEN_KEY)).toBe('1');
    expect(mutate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('heading', { name: /Where do you want TruePPM to open/i }),
    ).not.toBeInTheDocument();
  });

  it('the ✕ button also skips', () => {
    render(<LandingPrimaryUsePrompt />);
    fireEvent.click(screen.getByRole('button', { name: /Skip — decide later/i }));
    expect(localStorage.getItem(LANDING_PROMPT_SEEN_KEY)).toBe('1');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('Set as my home PATCHes the selected value (My Work is the default selection)', () => {
    render(<LandingPrimaryUsePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Set as my home' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe('my_work');
  });

  it('selecting Portfolio is blocked in community (disabled radio)', () => {
    render(<LandingPrimaryUsePrompt />);
    const portfolio = screen.getByRole('radio', { name: /Portfolio/i });
    expect(portfolio).toBeDisabled();
  });

  it('all four options are in a single role="radiogroup" (items 1+2, WCAG 1.3.1)', () => {
    render(<LandingPrimaryUsePrompt />);
    // There must be exactly ONE radiogroup so AT can arrow between all options.
    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(1);
    // Auto is inside that group.
    expect(screen.getByRole('radio', { name: /Auto \(recommended\)/i })).toBeInTheDocument();
    // All four radios: My Work, project overview, Portfolio, Auto.
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
  });

  it('on save success it marks seen and announces Saved', () => {
    // onSuccess runs synchronously here, so the "Saved." line + seen flag are
    // observable immediately — before the 900ms animate-out timer fires.
    mutate.mockImplementation((_value: unknown, opts?: MutateOpts) => opts?.onSuccess?.());
    render(<LandingPrimaryUsePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Set as my home' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(localStorage.getItem(LANDING_PROMPT_SEEN_KEY)).toBe('1');
  });

  it('disables Set as my home when offline; Skip still works', () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<LandingPrimaryUsePrompt />);
    expect(screen.getByRole('button', { name: 'Set as my home' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(localStorage.getItem(LANDING_PROMPT_SEEN_KEY)).toBe('1');
    spy.mockRestore();
  });

  it('on PATCH error keeps the card open and shows the error line', () => {
    mutationState = { isPending: false, isError: true };
    render(<LandingPrimaryUsePrompt />);
    expect(screen.getByRole('status')).toHaveTextContent(/Couldn.t save preference/i);
    expect(
      screen.getByRole('heading', { name: /Where do you want TruePPM to open/i }),
    ).toBeInTheDocument();
  });
});
