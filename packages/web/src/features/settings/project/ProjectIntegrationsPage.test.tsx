import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectIntegrationsPage } from './ProjectIntegrationsPage';
import type { IntegrationScope } from '@/hooks/useWebhooks';

const useProjectId = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
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

vi.mock('../components/integrations/GitAutomationManager', () => ({
  GitAutomationManager: ({ projectId }: { projectId: string }) => (
    <div data-testid="git-automation-manager">{projectId}</div>
  ),
}));

beforeEach(() => {
  useProjectId.mockReturnValue('p-1');
});

describe('ProjectIntegrationsPage', () => {
  it('renders the webhooks and API-token managers at project scope', () => {
    render(<ProjectIntegrationsPage />);
    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByTestId('webhooks-manager')).toHaveTextContent('project:p-1');
    expect(screen.getByTestId('tokens-manager')).toHaveTextContent('project:p-1');
    expect(screen.getByTestId('git-automation-manager')).toHaveTextContent('p-1');
  });

  it('renders the connected-accounts teaser', () => {
    render(<ProjectIntegrationsPage />);
    expect(screen.getByText(/Your connected accounts/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Manage credentials/i }),
    ).toHaveAttribute('href', '/me/settings/connected-accounts');
  });

  it('renders the connector roadmap callout (#588)', () => {
    render(<ProjectIntegrationsPage />);
    expect(screen.getByRole('heading', { name: 'Coming soon' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#570' })).toHaveAttribute(
      'href',
      'https://gitlab.com/trueppm/trueppm/-/issues/570',
    );
  });

  it('links each integration section to its docs page (#2266)', () => {
    render(<ProjectIntegrationsPage />);
    expect(screen.getByRole('link', { name: 'webhooks' })).toHaveAttribute(
      'href',
      expect.stringContaining('features/webhooks') as unknown as string,
    );
    expect(screen.getByRole('link', { name: 'API tokens' })).toHaveAttribute(
      'href',
      expect.stringContaining('features/personal-access-tokens') as unknown as string,
    );
    expect(screen.getByRole('link', { name: 'Git-event automation' })).toHaveAttribute(
      'href',
      expect.stringContaining('administration/git-event-automation') as unknown as string,
    );
  });

  it('returns null when projectId is unavailable', () => {
    useProjectId.mockReturnValue(undefined);
    const { container } = render(<ProjectIntegrationsPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
