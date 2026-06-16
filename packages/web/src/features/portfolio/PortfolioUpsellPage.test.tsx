import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortfolioUpsellPage } from './PortfolioUpsellPage';

const useEdition = vi.fn();

vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => useEdition() as { edition: string; isLoading: boolean },
}));

function renderShim() {
  return render(
    <MemoryRouter initialEntries={['/portfolio-upsell']}>
      <Routes>
        <Route path="/portfolio-upsell" element={<PortfolioUpsellPage />} />
        <Route path="/portfolio" element={<div data-testid="real-portfolio">real portfolio</div>} />
        <Route path="/programs" element={<div data-testid="programs">programs</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useEdition.mockReset();
});

describe('PortfolioUpsellPage', () => {
  it('renders the designed upsell surface under the community edition', () => {
    useEdition.mockReturnValue({ edition: 'community', isLoading: false });
    renderShim();
    expect(
      screen.getByRole('heading', { level: 1, name: /Portfolio rollup/i }),
    ).toBeInTheDocument();
    // The four governance capabilities are the value prop.
    expect(screen.getByText(/Portfolio dashboard & health rollups/i)).toBeInTheDocument();
    expect(screen.getByText(/Cross-program resource leveling/i)).toBeInTheDocument();
    // The primary CTA is an external link opening in a new tab (rule 121).
    const cta = screen.getByRole('link', {
      name: /Explore TruePPM Enterprise \(opens in a new tab\)/i,
    });
    expect(cta).toHaveAttribute('href', 'https://trueppm.com/enterprise');
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta).toHaveAttribute('rel', 'noopener noreferrer');
    // Not a redirect — the real portfolio is never rendered for community.
    expect(screen.queryByTestId('real-portfolio')).not.toBeInTheDocument();
  });

  it('redirects to the real /portfolio under the enterprise edition', async () => {
    useEdition.mockReturnValue({ edition: 'enterprise', isLoading: false });
    renderShim();
    await waitFor(() => {
      expect(screen.getByTestId('real-portfolio')).toBeInTheDocument();
    });
    // The upsell content never renders for an enterprise user.
    expect(screen.queryByRole('heading', { level: 1, name: /Portfolio rollup/i })).toBeNull();
  });

  it('shows a loading state while the edition resolves (no community-default flash)', () => {
    // useEdition defaults to 'community' while loading; the isLoading guard must
    // win so an enterprise user never sees a flash of the upsell.
    useEdition.mockReturnValue({ edition: 'community', isLoading: true });
    renderShim();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /Portfolio rollup/i })).toBeNull();
    expect(screen.queryByTestId('real-portfolio')).not.toBeInTheDocument();
  });
});
