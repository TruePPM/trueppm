import { describe, it, expect } from 'vitest';
import type { ProjectResource } from '@/types';
import {
  COMMAND_MENU,
  applySuggestion,
  commandSuggestions,
  deliveryModeSuggestions,
  durationSuggestions,
  ownerSuggestions,
  parentSuggestions,
  predecessorSuggestions,
  suggestionsForFragment,
} from './tokenSuggestions';
import { activeTokenFragment, type ParentCandidate, type PredecessorCandidate } from './authoringTokens';

function resource(id: string, name: string, roleTitle?: string): ProjectResource {
  return { resourceId: id, resource: { id, name }, roleTitle } as unknown as ProjectResource;
}

const POOL: ProjectResource[] = [
  resource('r-ana', 'Ana Rivera', 'Engineer'),
  resource('r-ben', 'Ben Okafor'),
];
const TASKS: PredecessorCandidate[] = [
  { id: 't-survey', name: 'Survey', wbs: '2.3' },
  { id: 't-design', name: 'Design', wbs: '2.4' },
];
const PHASES: ParentCandidate[] = [{ id: 'p-build', name: 'Build' }];
const CTX = { pool: POOL, tasks: TASKS, phases: PHASES };

describe('durationSuggestions', () => {
  it('offers common spans for an empty fragment', () => {
    expect(durationSuggestions('').map((s) => s.hint)).toEqual([
      '#1d',
      '#3d',
      '#5d',
      '#2w',
      '#0',
    ]);
  });

  it('offers both units for a typed number so the suffix need not be guessed', () => {
    const s = durationSuggestions('2');
    expect(s.map((x) => x.hint)).toEqual(['#2d', '#2w']);
    expect(s[1].label).toContain('10 days');
  });

  it('singularizes one day', () => {
    expect(durationSuggestions('1')[0].label).toBe('1 day');
  });

  it('offers only the milestone for a typed zero', () => {
    expect(durationSuggestions('0')).toEqual([
      { id: '#0', label: 'Milestone (zero duration)', hint: '#0' },
    ]);
  });
});

describe('ownerSuggestions', () => {
  it('filters the roster case-insensitively and carries the role as a hint', () => {
    expect(ownerSuggestions('ana', POOL)).toEqual([
      { id: 'r-ana', label: 'Ana Rivera', hint: 'Engineer' },
    ]);
  });

  it('offers the whole roster for an empty fragment', () => {
    expect(ownerSuggestions('', POOL)).toHaveLength(2);
  });
});

describe('predecessorSuggestions', () => {
  it('matches on name', () => {
    expect(predecessorSuggestions('sur', TASKS).map((s) => s.id)).toEqual(['t-survey']);
  });

  it('matches on WBS path', () => {
    expect(predecessorSuggestions('2.4', TASKS).map((s) => s.id)).toEqual(['t-design']);
  });

  it('shows the WBS path as the hint', () => {
    expect(predecessorSuggestions('sur', TASKS)[0].hint).toBe('2.3');
  });
});

describe('deliveryModeSuggestions', () => {
  it('offers every mode word for an empty fragment', () => {
    expect(deliveryModeSuggestions('').length).toBeGreaterThan(4);
  });

  it('filters to the typed prefix', () => {
    expect(deliveryModeSuggestions('spr').map((s) => s.label)).toEqual(['sprint']);
  });
});

describe('parentSuggestions', () => {
  it('offers phases only', () => {
    expect(parentSuggestions('bu', PHASES)).toEqual([
      { id: 'p-build', label: 'Build', hint: 'phase' },
    ]);
  });
});

describe('commandSuggestions', () => {
  it('offers every token and toolbar action for a bare /', () => {
    expect(commandSuggestions('')).toEqual(COMMAND_MENU);
  });

  it('matches on the human label, not only the sigil', () => {
    expect(commandSuggestions('owner').map((c) => c.id)).toEqual(['owner']);
  });

  it('matches on the sigil too', () => {
    expect(commandSuggestions('~sprint').map((c) => c.id)).toEqual(['mode-sprint']);
  });

  it('inserts a bare sigil for the tokens that open a picker', () => {
    // Selecting "Set duration" must land the author inside the `#` picker rather
    // than completing anything on its own — the menu is a route into the grammar.
    expect(COMMAND_MENU.find((c) => c.id === 'duration')?.insert).toBe('#');
    expect(COMMAND_MENU.find((c) => c.id === 'owner')?.insert).toBe('@');
  });

  it('inserts a complete token for the ones with nothing left to choose', () => {
    expect(COMMAND_MENU.find((c) => c.id === 'milestone')?.insert).toBe('! ');
  });
});

describe('suggestionsForFragment', () => {
  it('routes an @ fragment to the roster', () => {
    const fragment = activeTokenFragment('Survey @an')!;
    const { suggestions, ariaLabel } = suggestionsForFragment(fragment, CTX);
    expect(ariaLabel).toBe('Assign owner');
    expect(suggestions.map((s) => s.id)).toEqual(['r-ana']);
  });

  it('routes a > fragment to the task list', () => {
    const fragment = activeTokenFragment('X >2.3')!;
    expect(suggestionsForFragment(fragment, CTX).suggestions.map((s) => s.id)).toEqual(['t-survey']);
  });

  it('routes a ~ fragment to the mode words', () => {
    const fragment = activeTokenFragment('X ~spr')!;
    expect(suggestionsForFragment(fragment, CTX).suggestions.map((s) => s.label)).toEqual([
      'sprint',
    ]);
  });

  it('routes a [ fragment to the phases', () => {
    const fragment = activeTokenFragment('X [Bu')!;
    expect(suggestionsForFragment(fragment, CTX).suggestions.map((s) => s.id)).toEqual(['p-build']);
  });

  it('routes a # fragment to durations', () => {
    const fragment = activeTokenFragment('X #5')!;
    expect(suggestionsForFragment(fragment, CTX).suggestions.map((s) => s.hint)).toEqual([
      '#5d',
      '#5w',
    ]);
  });
});

describe('applySuggestion', () => {
  it('replaces the fragment under the caret and leaves the rest alone', () => {
    const draft = 'Survey @an';
    const fragment = activeTokenFragment(draft)!;
    expect(applySuggestion(draft, fragment, '@"Ana Rivera"')).toBe('Survey @"Ana Rivera"');
  });

  it('preserves text after the fragment', () => {
    const draft = 'Survey @an rest';
    const fragment = activeTokenFragment(draft, 10)!;
    expect(applySuggestion(draft, fragment, '@ana')).toBe('Survey @ana rest');
  });
});
