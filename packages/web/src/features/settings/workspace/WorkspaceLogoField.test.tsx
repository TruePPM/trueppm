import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceLogoField } from './WorkspaceLogoField';

function renderField(logoUrl: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceLogoField logoUrl={logoUrl} name="Acme Co" />
    </QueryClientProvider>,
  );
}

describe('WorkspaceLogoField', () => {
  it('renders the letter-mark fallback when no logo is set', () => {
    renderField(null);
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  // #2198: the destructive "Remove" affordance must use the DEFINED semantic
  // tokens, not the undefined `danger-*` tokens that emit no CSS (Tailwind
  // silently drops an unknown token), which stripped the danger styling entirely.
  it('the Remove button carries the defined semantic-critical danger tokens, not undefined danger-* tokens', () => {
    renderField('https://cdn.example.com/logo.png');
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.className).toContain('hover:text-semantic-critical');
    expect(remove.className).toContain('hover:bg-semantic-critical-bg');
    expect(remove.className).toContain('focus-visible:ring-semantic-critical');
    // The undefined tokens must be gone — they compile to no CSS.
    expect(remove.className).not.toContain('danger');
  });

  it('the confirm "Yes, remove" button carries the defined semantic-critical danger tokens', () => {
    renderField('https://cdn.example.com/logo.png');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const confirm = screen.getByRole('button', { name: 'Yes, remove' });
    expect(confirm.className).toContain('text-semantic-critical');
    expect(confirm.className).toContain('hover:bg-semantic-critical-bg');
    expect(confirm.className).toContain('focus-visible:ring-semantic-critical');
    expect(confirm.className).not.toContain('danger');
  });
});
