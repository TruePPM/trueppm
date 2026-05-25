import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProgramIntegrationsPage } from './ProgramIntegrationsPage';
import type { IntegrationScope } from '@/hooks/useWebhooks';

const useParams = vi.fn(() => ({ programId: 'prog-1' }) as { programId?: string });

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useParams: () => useParams(),
}));

vi.mock('@/lib/widget-registry', () => ({
  registry: { get: () => [] as unknown[] },
}));

vi.mock('../components/integrations/WebhooksManager', () => ({
  WebhooksManager: ({ scope }: { scope: IntegrationScope }) => (
    <div data-testid="webhooks-manager">{`${scope.kind}:${scope.id}`}</div>
  ),
}));

vi.mock('../components/integrations/ApiTokensManager', () => ({
  ApiTokensManager: ({ scope }: { scope: IntegrationScope }) => (
    <div data-testid="tokens-manager">{`${scope.kind}:${scope.id}`}</div>
  ),
}));

describe('ProgramIntegrationsPage', () => {
  it('renders the webhooks and API-token managers at program scope', () => {
    useParams.mockReturnValue({ programId: 'prog-1' });
    render(<ProgramIntegrationsPage />);
    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByTestId('webhooks-manager')).toHaveTextContent('program:prog-1');
    expect(screen.getByTestId('tokens-manager')).toHaveTextContent('program:prog-1');
  });

  it('renders the connector roadmap callout (#588)', () => {
    useParams.mockReturnValue({ programId: 'prog-1' });
    render(<ProgramIntegrationsPage />);
    expect(screen.getByRole('heading', { name: 'Coming soon' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#500' })).toHaveAttribute(
      'href',
      'https://gitlab.com/trueppm/trueppm/-/issues/500',
    );
  });

  it('returns null when programId is unavailable', () => {
    useParams.mockReturnValue({});
    const { container } = render(<ProgramIntegrationsPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
