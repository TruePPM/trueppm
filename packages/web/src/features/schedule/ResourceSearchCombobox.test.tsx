/**
 * Tests for ResourceSearchCombobox — the assignment resource picker.
 *
 * Two modes share one control: a flat name search (no `taskId`) and the skill-fit
 * mode (`taskId` given) that groups results into Best / Partial / No skill match.
 * The API layer is mocked; the real hooks + TanStack Query run so the debounce,
 * grouping, and keyboard traversal are exercised end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { ResourceSearchCombobox } from './ResourceSearchCombobox';
import type { Proficiency } from '@/types';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ApiSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: Proficiency;
}

interface ApiMissingSkill {
  skill_id: string;
  skill_name: string;
  required: Proficiency;
  required_label: string;
  actual: number;
  actual_label: string;
}

interface ApiResource {
  id: string;
  name: string;
  email: string;
  job_role: string;
  max_units: string;
  calendar: string | null;
  skills: ApiSkill[];
  skill_fit?: 'exact' | 'partial' | 'missing';
  missing_skills?: ApiMissingSkill[];
}

interface GetConfig {
  params?: { search?: string; task?: string };
}

function skill(name: string, proficiency: Proficiency = 2): ApiSkill {
  return {
    id: `rs-${name}`,
    resource: 'r',
    skill: `sk-${name}`,
    skill_name: name,
    proficiency,
  };
}

function missingSkill(name: string): ApiMissingSkill {
  return {
    skill_id: `sk-${name}`,
    skill_name: name,
    required: 3,
    required_label: 'Expert',
    actual: 0,
    actual_label: 'None',
  };
}

function resource(
  id: string,
  name: string,
  extra: Partial<Pick<ApiResource, 'skill_fit' | 'skills' | 'missing_skills'>> = {},
): ApiResource {
  return {
    id,
    name,
    email: `${id}@example.com`,
    job_role: 'Engineer',
    max_units: '1.00',
    calendar: null,
    skills: [],
    ...extra,
  };
}

function page(results: ApiResource[]) {
  return { data: { count: results.length, next: null, previous: null, results } };
}

/** Resolve every `/resources/` request with the same page. */
function mockResources(results: ApiResource[]) {
  getMock.mockImplementation(() => Promise.resolve(page(results)));
}

function renderCombobox(props: { taskId?: string } = {}) {
  const onSelect = vi.fn<(id: string, name: string) => void>();
  const onDismiss = vi.fn<() => void>();
  renderWithProviders(
    <ResourceSearchCombobox onSelect={onSelect} onDismiss={onDismiss} {...props} />,
  );
  return { onSelect, onDismiss };
}

function input() {
  return screen.getByRole<HTMLInputElement>('combobox');
}

beforeEach(() => {
  getMock.mockReset();
  mockResources([]);
});

// ---------------------------------------------------------------------------
// Flat (no taskId) mode
// ---------------------------------------------------------------------------

describe('ResourceSearchCombobox — flat search', () => {
  it('preloads on mount and lists the returned resources as options', async () => {
    mockResources([resource('r1', 'Alice'), resource('r2', 'Bob')]);
    renderCombobox();

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Alice', 'Bob']);
    expect(getMock).toHaveBeenCalledWith('/resources/', { params: { search: '' } });
    expect(input()).toHaveAttribute('aria-expanded', 'true');
  });

  it('never asks for the skill-fit annotation without a taskId', async () => {
    mockResources([resource('r1', 'Alice')]);
    renderCombobox();

    await screen.findByRole('option', { name: 'Alice' });
    for (const call of getMock.mock.calls) {
      const config = call[1] as GetConfig | undefined;
      expect(config?.params?.task).toBeUndefined();
    }
  });

  it('caps the list at 20 options even when the API returns more', async () => {
    mockResources(
      Array.from({ length: 25 }, (_, i) => resource(`r${i}`, `Person ${String(i)}`)),
    );
    renderCombobox();

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(20);
  });

  it('shows no listbox and collapses the combobox while the search is in flight', () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    renderCombobox();

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows no listbox when the search returns nothing', async () => {
    mockResources([]);
    renderCombobox();

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input()).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('debounces typing into a single search request for the settled query', async () => {
    mockResources([resource('r1', 'Alice')]);
    renderCombobox();
    await screen.findByRole('option', { name: 'Alice' });

    fireEvent.change(input(), { target: { value: 'al' } });
    fireEvent.change(input(), { target: { value: 'ali' } });
    expect(input().value).toBe('ali');

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/resources/', { params: { search: 'ali' } }),
    );
    // The intermediate keystroke never reached the API.
    expect(getMock).not.toHaveBeenCalledWith('/resources/', { params: { search: 'al' } });
  });

  it('selects a resource on pointer down', async () => {
    mockResources([resource('r1', 'Alice'), resource('r2', 'Bob')]);
    const { onSelect } = renderCombobox();

    fireEvent.pointerDown(await screen.findByRole('option', { name: 'Bob' }));

    expect(onSelect).toHaveBeenCalledWith('r2', 'Bob');
  });
});

describe('ResourceSearchCombobox — keyboard traversal', () => {
  async function renderWithTwo() {
    mockResources([resource('r1', 'Alice'), resource('r2', 'Bob')]);
    const handles = renderCombobox();
    await screen.findByRole('option', { name: 'Alice' });
    return handles;
  }

  it('starts with no active option', async () => {
    await renderWithTwo();
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getByRole('option', { name: 'Alice' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('ArrowDown activates the first option and points aria-activedescendant at it', async () => {
    await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });

    expect(screen.getByRole('option', { name: 'Alice' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-option-0$/);
  });

  it('ArrowDown stops at the last option instead of running off the end', async () => {
    await renderWithTwo();

    for (let i = 0; i < 4; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' });

    expect(screen.getByRole('option', { name: 'Bob' })).toHaveAttribute('aria-selected', 'true');
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-option-1$/);
  });

  it('ArrowUp stops at the first option instead of going back to none', async () => {
    await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });

    expect(screen.getByRole('option', { name: 'Alice' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('Enter selects the active option', async () => {
    const { onSelect } = await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('r2', 'Bob');
  });

  it('Enter does nothing while no option is active', async () => {
    const { onSelect } = await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape dismisses the picker', async () => {
    const { onDismiss, onSelect } = await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores keys it does not handle', async () => {
    const { onDismiss, onSelect } = await renderWithTwo();

    fireEvent.keyDown(input(), { key: 'a' });
    fireEvent.keyDown(input(), { key: 'Tab' });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(input()).not.toHaveAttribute('aria-activedescendant');
  });

  it('drops the active option when a new query loads a different result set', async () => {
    getMock.mockImplementation((_url: string, config?: GetConfig) =>
      Promise.resolve(
        page(
          config?.params?.search === 'z'
            ? [resource('r9', 'Zoe')]
            : [resource('r1', 'Alice'), resource('r2', 'Bob')],
        ),
      ),
    );
    renderCombobox();
    await screen.findByRole('option', { name: 'Alice' });

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-option-0$/);

    fireEvent.change(input(), { target: { value: 'z' } });
    await screen.findByRole('option', { name: 'Zoe' });

    expect(input()).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getByRole('option', { name: 'Zoe' })).toHaveAttribute('aria-selected', 'false');
  });
});

// ---------------------------------------------------------------------------
// Skill-fit (taskId) mode
// ---------------------------------------------------------------------------

describe('ResourceSearchCombobox — skill-fit mode', () => {
  const graded = [
    resource('r1', 'Alice', { skill_fit: 'exact', skills: [skill('React', 3)] }),
    resource('r2', 'Bob', {
      skill_fit: 'partial',
      skills: [skill('React', 1)],
      missing_skills: [missingSkill('Rust')],
    }),
    resource('r3', 'Cara', { skill_fit: 'missing', missing_skills: [missingSkill('React')] }),
  ];

  it('requests the skill-fit annotation for the task', async () => {
    mockResources(graded);
    renderCombobox({ taskId: 'task-1' });

    await screen.findByRole('option', { name: /Alice/ });
    expect(getMock).toHaveBeenCalledWith('/resources/', {
      params: { search: '', task: 'task-1' },
    });
  });

  it('groups results under Best fit / Partial fit / No skill match', async () => {
    mockResources(graded);
    renderCombobox({ taskId: 'task-1' });

    await screen.findByRole('option', { name: /Alice/ });
    expect(screen.getByText('Best fit')).toBeInTheDocument();
    expect(screen.getByText('Partial fit')).toBeInTheDocument();
    expect(screen.getByText('No skill match')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('omits a group header when that bucket is empty', async () => {
    mockResources([graded[0], graded[2]]);
    renderCombobox({ taskId: 'task-1' });

    await screen.findByRole('option', { name: /Alice/ });
    expect(screen.getByText('Best fit')).toBeInTheDocument();
    expect(screen.getByText('No skill match')).toBeInTheDocument();
    expect(screen.queryByText('Partial fit')).toBeNull();
  });

  it('shows at most four skill chips and two missing-skill chips per resource', async () => {
    mockResources([
      resource('r1', 'Alice', {
        skill_fit: 'partial',
        skills: [skill('React'), skill('Go'), skill('Rust'), skill('SQL'), skill('Elm')],
        missing_skills: [missingSkill('Kafka'), missingSkill('Terraform'), missingSkill('Helm')],
      }),
    ]);
    renderCombobox({ taskId: 'task-1' });

    const option = await screen.findByRole('option', { name: /Alice/ });
    expect(within(option).getByText('React')).toBeInTheDocument();
    expect(within(option).getByText('SQL')).toBeInTheDocument();
    expect(within(option).queryByText('Elm')).toBeNull();
    expect(within(option).getByText('Missing: Kafka')).toBeInTheDocument();
    expect(within(option).getByText('Missing: Terraform')).toBeInTheDocument();
    expect(within(option).queryByText('Missing: Helm')).toBeNull();
  });

  it('traverses groups in Best → Partial → No-match order with the keyboard', async () => {
    mockResources(graded);
    const { onSelect } = renderCombobox({ taskId: 'task-1' });
    await screen.findByRole('option', { name: /Alice/ });

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });

    expect(screen.getByRole('option', { name: /Bob/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Alice/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('r2', 'Bob');
  });

  it('clamps the keyboard cursor to the last grouped option', async () => {
    mockResources(graded);
    const { onSelect } = renderCombobox({ taskId: 'task-1' });
    await screen.findByRole('option', { name: /Alice/ });

    for (let i = 0; i < 6; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('r3', 'Cara');
  });

  it('selects a grouped resource on pointer down', async () => {
    mockResources(graded);
    const { onSelect } = renderCombobox({ taskId: 'task-1' });

    fireEvent.pointerDown(await screen.findByRole('option', { name: /Cara/ }));

    expect(onSelect).toHaveBeenCalledWith('r3', 'Cara');
  });

  it('shows no listbox when no resource matches the task', async () => {
    mockResources([]);
    renderCombobox({ taskId: 'task-1' });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(input()).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('Best fit')).toBeNull();
  });
});
