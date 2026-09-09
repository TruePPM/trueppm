import { describe, expect, it } from 'vitest';
import { BACKLOG_ITEM_TYPES } from './types';
import {
  defaultItemType,
  itemTypesFor,
  pointsFieldLabel,
  resolveMethodology,
} from './methodologyVocabulary';

describe('methodologyVocabulary (#3644)', () => {
  describe('resolveMethodology', () => {
    it('falls back to HYBRID on an unresolved program query', () => {
      // HYBRID is the `Program.methodology` model default and the one preset
      // `methodologyTabs` hides nothing under, so an in-flight query renders the
      // lossless vocabulary rather than flashing agile nouns and swapping them.
      expect(resolveMethodology(undefined)).toBe('HYBRID');
    });

    it('passes a resolved value through unchanged', () => {
      expect(resolveMethodology('WATERFALL')).toBe('WATERFALL');
      expect(resolveMethodology('AGILE')).toBe('AGILE');
    });
  });

  describe('pointsFieldLabel', () => {
    it('drops the agile noun on WATERFALL only', () => {
      expect(pointsFieldLabel('WATERFALL')).toBe('Estimate');
      expect(pointsFieldLabel('AGILE')).toBe('Story points');
      expect(pointsFieldLabel('HYBRID')).toBe('Story points');
    });
  });

  describe('defaultItemType', () => {
    it('starts WATERFALL on task and everything else on story', () => {
      expect(defaultItemType('WATERFALL')).toBe('task');
      expect(defaultItemType('AGILE')).toBe('story');
      expect(defaultItemType('HYBRID')).toBe('story');
    });
  });

  describe('itemTypesFor', () => {
    it.each(['WATERFALL', 'AGILE', 'HYBRID'] as const)(
      'offers the complete type set on %s',
      (methodology) => {
        // The SET is the invariant, not the order. `item_type` is persisted, so a
        // methodology-narrowed list would make an existing item unrepresentable
        // in its own edit dropdown after a preset flip — the destructive-on-switch
        // defect `pointInputOptions` already guards against for estimation scales.
        expect([...itemTypesFor(methodology)].sort()).toEqual([...BACKLOG_ITEM_TYPES].sort());
      },
    );

    it('leads with the methodology default', () => {
      expect(itemTypesFor('WATERFALL')[0]).toBe('task');
      expect(itemTypesFor('AGILE')[0]).toBe('story');
    });

    it('never repeats the lead type', () => {
      const types = itemTypesFor('WATERFALL');
      expect(new Set(types).size).toBe(types.length);
    });
  });
});
