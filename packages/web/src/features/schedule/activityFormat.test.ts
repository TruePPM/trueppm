import { describe, it, expect } from 'vitest';
import type { TaskActivityEntry } from '@/hooks/useTaskHistory';
import { fieldLabel, changeVerb, summaryVerb, isEmptyChange } from './activityFormat';

function entry(overrides: Partial<TaskActivityEntry>): TaskActivityEntry {
  return {
    event_type: 'fields_changed',
    actor: { id: 'u1', display_name: 'Alice' },
    timestamp: '2026-04-25T10:00:00Z',
    detail: {},
    ...overrides,
  } as TaskActivityEntry;
}

describe('activityFormat', () => {
  describe('fieldLabel', () => {
    it('maps known keys and passes through unknown ones', () => {
      expect(fieldLabel('percent_complete')).toBe('Progress');
      expect(fieldLabel('planned_start')).toBe('Start date');
      expect(fieldLabel('some_unmapped_field')).toBe('some_unmapped_field');
    });
    it('names the inherit bit for what it says, not for its column (#3306)', () => {
      // The server surfaces this field only when it is a record's ONLY change — a
      // cascade that broke the root's inheritance and moved nothing else. Falling
      // through to the raw key would render "parent_governance_inherited" in the
      // Activity tab, which is the bug's "no legible record" in a second form.
      expect(fieldLabel('parent_governance_inherited')).toBe('Governance source');
    });
  });

  describe('changeVerb', () => {
    it('names a single changed field, lower-cased', () => {
      expect(changeVerb(entry({ diff: [{ field: 'duration', old: '8', new: '10' }] }))).toBe(
        'changed duration',
      );
    });
    it('counts a multi-field change', () => {
      expect(
        changeVerb(
          entry({
            diff: [
              { field: 'duration', old: '8', new: '10' },
              { field: 'status', old: 'a', new: 'b' },
            ],
          }),
        ),
      ).toBe('updated 2 fields');
    });
  });

  describe('summaryVerb', () => {
    it('renders fixed phrases per event type', () => {
      expect(summaryVerb(entry({ event_type: 'comment_added' }))).toBe('commented');
      expect(summaryVerb(entry({ event_type: 'cpm_recalculated' }))).toBe('recalculated the schedule');
      expect(summaryVerb(entry({ event_type: 'risk_linked' }))).toBe('linked a risk');
    });
    it('varies the attachment verb by kind', () => {
      expect(summaryVerb(entry({ event_type: 'attachment_uploaded', detail: { kind: 'url' } }))).toBe(
        'attached a link',
      );
      expect(summaryVerb(entry({ event_type: 'attachment_uploaded', detail: { kind: 'file' } }))).toBe(
        'attached a file',
      );
    });
    it('delegates field-diff events to changeVerb', () => {
      expect(summaryVerb(entry({ diff: [{ field: 'name', old: 'a', new: 'b' }] }))).toBe(
        'changed name',
      );
    });
    it('humanizes an unknown event type rather than crashing', () => {
      expect(summaryVerb(entry({ event_type: 'some_new_event' }))).toBe('some new event');
    });
  });

  describe('isEmptyChange', () => {
    it('flags a fields_changed with no diff, nothing else', () => {
      expect(isEmptyChange(entry({ event_type: 'fields_changed', diff: [] }))).toBe(true);
      expect(isEmptyChange(entry({ event_type: 'fields_changed', diff: [{ field: 'x', old: '1', new: '2' }] }))).toBe(false);
      expect(isEmptyChange(entry({ event_type: 'comment_added' }))).toBe(false);
    });
  });
});
