import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictChip, includes, scopeInWords } from './agentWords';

const AREAS = [
  { key: 'schedule', label: 'Schedule & tasks' },
  { key: 'dependencies', label: 'Dependencies' },
  { key: 'resources', label: 'Resources' },
  { key: 'baselines', label: 'Baselines' },
];

describe('VerdictChip', () => {
  it('renders Refused as glyph + word with the guard named, never red', () => {
    const { container } = render(<VerdictChip verdict="refused" constraint="agent_paused" />);
    expect(screen.getByText('Refused')).toBeTruthy();
    expect(screen.getByText(/paused/)).toBeTruthy();
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/critical|red-/);
  });

  it('renders Allowed and Requires approval with a word each', () => {
    render(
      <>
        <VerdictChip verdict="allowed" />
        <VerdictChip verdict="requires_approval" />
      </>,
    );
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('Requires approval')).toBeTruthy();
  });
});

describe('scope words', () => {
  it('treats the level ladder as cumulative', () => {
    expect(includes('propose', 'read')).toBe(true);
    expect(includes('read', 'propose')).toBe(false);
    expect(includes(undefined, 'read')).toBe(false);
  });

  it('describes a scope in words', () => {
    expect(
      scopeInWords(
        { schedule: 'read', dependencies: 'read', resources: 'read', baselines: 'read' },
        AREAS,
      ),
    ).toBe('Reads everything');
    expect(
      scopeInWords(
        { schedule: 'propose', dependencies: 'read', resources: 'none', baselines: 'none' },
        AREAS,
      ),
    ).toBe('Reads schedule & tasks, dependencies; dry run on schedule & tasks');
    expect(scopeInWords({ schedule: 'none' }, AREAS)).toBe('No access');
  });
});
