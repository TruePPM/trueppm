import { describe, it, expect } from 'vitest';
import { iterationLabelForms, DEFAULT_ITERATION_LABEL } from './iterationLabel';

describe('iterationLabelForms', () => {
  it('derives all forms for the default "Sprint"', () => {
    expect(iterationLabelForms('Sprint')).toEqual({
      singular: 'Sprint',
      plural: 'Sprints',
      lower: 'sprint',
      lowerPlural: 'sprints',
      possessive: "Sprint's",
    });
  });

  it('pluralizes the named presets correctly', () => {
    expect(iterationLabelForms('Iteration').plural).toBe('Iterations');
    expect(iterationLabelForms('PI').plural).toBe('PIs');
  });

  it.each([
    ['Cycle', 'Cycles'],
    ['Increment', 'Increments'],
    ['Phase', 'Phases'], // -se → +s already ends in e, naive +s is correct
    ['Batch', 'Batches'], // -ch → +es
    ['Box', 'Boxes'], // -x → +es
    ['Story', 'Stories'], // consonant + y → -ies
    ['Day', 'Days'], // vowel + y → +s (not "Daies")
  ])('pluralizes custom noun %s → %s', (singular, plural) => {
    expect(iterationLabelForms(singular).plural).toBe(plural);
  });

  it('lowercases plural for count copy', () => {
    expect(iterationLabelForms('Iteration').lowerPlural).toBe('iterations');
    expect(iterationLabelForms('Batch').lowerPlural).toBe('batches');
  });

  it('builds the possessive form', () => {
    expect(iterationLabelForms('Iteration').possessive).toBe("Iteration's");
  });

  it('trims surrounding whitespace before deriving', () => {
    expect(iterationLabelForms('  Cycle  ').singular).toBe('Cycle');
    expect(iterationLabelForms('  Cycle  ').plural).toBe('Cycles');
  });

  it.each([null, undefined, '', '   '])(
    'falls back to the default for blank input (%s)',
    (input) => {
      const forms = iterationLabelForms(input);
      expect(forms.singular).toBe(DEFAULT_ITERATION_LABEL);
      expect(forms.plural).toBe('Sprints');
    },
  );
});
