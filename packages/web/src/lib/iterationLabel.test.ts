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

  it('preserves acronym casing in the lower forms (PI, not pi)', () => {
    expect(iterationLabelForms('PI')).toEqual({
      singular: 'PI',
      plural: 'PIs',
      lower: 'PI',
      lowerPlural: 'PIs',
      possessive: "PI's",
    });
  });

  // The acronym rule is "any all-caps token", not a preset list — a company
  // that prefers a custom acronym (e.g. "ITER" over "Iteration") gets the same
  // casing preservation as the well-known "PI".
  it.each([
    ['FAT', 'FATs'],
    ['ITER', 'ITERs'],
    ['CYC', 'CYCs'],
  ])('preserves casing for custom all-caps acronym %s', (singular, lowerPlural) => {
    const forms = iterationLabelForms(singular);
    expect(forms.lower).toBe(singular);
    expect(forms.lowerPlural).toBe(lowerPlural);
  });

  it('still lowercases an ordinary mixed-case shortening (Iter → iter)', () => {
    // Only ALL-caps is treated as an acronym; a mixed-case label lowercases
    // normally, so the rule stays predictable ("type it in caps to keep caps").
    expect(iterationLabelForms('Iter').lower).toBe('iter');
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
