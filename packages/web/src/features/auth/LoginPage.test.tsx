import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { renderWithRouter } from '@/test/utils';
import { LoginPage, loginRedirectDest } from './LoginPage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// useNavigate and useSearchParams come from the MemoryRouter in renderWithRouter.
describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the brand, email field, password field, and sign-in button', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(screen.getByText('TruePPM')).toBeInTheDocument();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the SSO button and remember-me checkbox', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(screen.getByLabelText('Keep me signed in for 30 days')).toBeInTheDocument();
  });

  it('sign-in button is disabled when both fields are empty', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('sign-in button is disabled when only email is filled', async () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('sign-in button is enabled when both email and password are filled', async () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows error message on 401 response', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
      }),
    );
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
    });
  });

  it('shows generic error on unexpected failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'any');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('unexpected error');
    });
  });

  it('shows SSO tooltip when SSO button is clicked', async () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Continue with SSO' }));

    expect(screen.getByRole('tooltip')).toHaveTextContent('SSO available in Enterprise tier');
  });

  it('remember-me checkbox toggles', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const checkbox = screen.getByLabelText('Keep me signed in for 30 days');

    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it('renders the marketing panel with status pill and mini-Gantt on desktop', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // The "hidden md:flex" panel is in the DOM even on jsdom — just hidden via CSS.
    // We can still assert on its text content.
    expect(screen.getByText('Schedules that hold under pressure.')).toBeInTheDocument();
    expect(screen.getByText(/CPM v.*live/)).toBeInTheDocument();
  });
});

describe('loginRedirectDest — post-login destination transform', () => {
  it('redirects /projects/{id}/board to /projects/{id}/overview', () => {
    expect(loginRedirectDest('/projects/abc-123/board')).toBe('/projects/abc-123/overview');
  });

  it('redirects nested board paths (e.g. /board?view=foo) to overview, dropping board children', () => {
    expect(loginRedirectDest('/projects/abc-123/board/anything')).toBe('/projects/abc-123/overview');
  });

  it('preserves the project id with hyphens and uuids', () => {
    const id = 'e2e-332-00000000-0000-0000-0000-000000000332';
    expect(loginRedirectDest(`/projects/${id}/board`)).toBe(`/projects/${id}/overview`);
  });

  it('passes through non-board project routes untouched (deep-link preservation)', () => {
    expect(loginRedirectDest('/projects/abc-123/risk')).toBe('/projects/abc-123/risk');
    expect(loginRedirectDest('/projects/abc-123/schedule')).toBe('/projects/abc-123/schedule');
    expect(loginRedirectDest('/projects/abc-123/sprints')).toBe('/projects/abc-123/sprints');
    expect(loginRedirectDest('/projects/abc-123/resources/roster')).toBe('/projects/abc-123/resources/roster');
  });

  it('passes through the root path untouched', () => {
    expect(loginRedirectDest('/')).toBe('/');
  });

  it('does not match unrelated paths that contain the substring "board"', () => {
    // "/dashboard" or "/projects/abc/dashboards" must not be rewritten.
    expect(loginRedirectDest('/dashboard')).toBe('/dashboard');
    expect(loginRedirectDest('/projects/abc/dashboards')).toBe('/projects/abc/dashboards');
  });
});
