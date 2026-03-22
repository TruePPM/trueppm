import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { renderWithProviders } from './test/utils';

describe('App', () => {
  it('renders the placeholder heading', () => {
    renderWithProviders(<App />);
    expect(screen.getByRole('heading', { name: /trueppm/i })).toBeInTheDocument();
  });

  it('does not render ReactQueryDevtools in test environment', () => {
    renderWithProviders(<App />);
    // Devtools are only rendered when import.meta.env.DEV is true; vitest sets DEV=false
    expect(document.querySelector('[data-testid="react-query-devtools"]')).toBeNull();
  });
});
