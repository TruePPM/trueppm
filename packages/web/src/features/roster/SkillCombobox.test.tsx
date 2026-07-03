import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { SkillCombobox } from './SkillCombobox';

// Mock apiClient so useSkillCatalog resolves against a controllable catalog.
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

const CATALOG = [
  { id: 'sk-react', name: 'React', normalized_name: 'react', category: 'Frontend' },
  { id: 'sk-django', name: 'Django', normalized_name: 'django', category: 'Backend' },
  { id: 'sk-rust', name: 'Rust', normalized_name: 'rust', category: 'Systems' },
];

beforeEach(() => {
  getMock.mockReset();
  // Return the whole catalog filtered by the ?search= param, mirroring the API.
  getMock.mockImplementation((_url: string, config?: { params?: { search?: string } }) => {
    const search = (config?.params?.search ?? '').toLowerCase();
    const results = CATALOG.filter((s) => s.name.toLowerCase().includes(search));
    return Promise.resolve({ data: { count: results.length, next: null, previous: null, results } });
  });
});

describe('SkillCombobox', () => {
  it('does not query the catalog until the user types', () => {
    renderWithProviders(<SkillCombobox onSelect={vi.fn()} />);
    // useSkillCatalog is disabled for an empty query.
    expect(getMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows matching skills in a listbox after a debounced search', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SkillCombobox onSelect={vi.fn()} />);

    await user.type(screen.getByRole('combobox'), 'ru');

    const listbox = await screen.findByRole('listbox', { name: /matching skills/i });
    expect(within(listbox).getByRole('option', { name: /rust/i })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /react/i })).not.toBeInTheDocument();
  });

  it('emits the selected skill and clears its query so another can be added', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<SkillCombobox onSelect={onSelect} />);

    const input = screen.getByRole<HTMLInputElement>('combobox');
    await user.type(input, 'react');
    const option = await screen.findByRole('option', { name: /react/i });
    await user.click(option);

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sk-react', name: 'React' }),
    );
    // Query cleared → listbox collapses, input empty, ready for the next add.
    expect(input.value).toBe('');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('supports keyboard selection (ArrowDown + Enter)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<SkillCombobox onSelect={onSelect} />);

    await user.type(screen.getByRole('combobox'), 'd');
    await screen.findByRole('option', { name: /django/i });
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'sk-django' }));
  });

  it('excludes already-tagged skills from the results', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SkillCombobox onSelect={vi.fn()} excludeSkillIds={['sk-react']} />,
    );

    await user.type(screen.getByRole('combobox'), 'r');
    // "Rust" still matches, but "React" is filtered out by exclusion.
    await screen.findByRole('option', { name: /rust/i });
    expect(screen.queryByRole('option', { name: /react/i })).not.toBeInTheDocument();
  });

  it('calls onDismiss when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderWithProviders(<SkillCombobox onSelect={vi.fn()} onDismiss={onDismiss} />);

    await user.type(screen.getByRole('combobox'), 'react');
    await user.keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalled();
  });
});
