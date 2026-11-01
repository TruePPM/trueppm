import { describe, expect, it } from 'vitest';
import {
  decidedLabel,
  decisionWriteAccess,
  dueLabel,
  impactProvenance,
  linkLabel,
  ownerName,
  type ProgramDecision,
} from './decisionListModel';

function decision(over: Partial<ProgramDecision> = {}): ProgramDecision {
  return {
    id: 'd1',
    server_version: 1,
    program: 'p1',
    title: 'Pick a vendor',
    owner: 7,
    owner_detail: { id: 7, username: 'dana', display_name: 'Dana Ruiz' },
    due_date: null,
    status: 'awaiting',
    decided_at: null,
    linked_task: null,
    linked_risk: null,
    link: null,
    impact_note: '',
    created_by: 7,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-28T12:00:00Z',
    ...over,
  };
}

const fmt = (iso: string) => `<${iso.slice(0, 10)}>`;

describe('ownerName', () => {
  it('names the owner, and says so explicitly when there is none', () => {
    expect(ownerName(decision())).toBe('Dana Ruiz');
    expect(ownerName(decision({ owner: null, owner_detail: null }))).toBe('No owner');
  });
});

describe('dueLabel', () => {
  const today = '2026-10-31';
  it('is null without a due date or once the decision is not awaiting', () => {
    expect(dueLabel(decision(), today, fmt)).toBeNull();
    expect(dueLabel(decision({ due_date: '2026-11-05', status: 'made' }), today, fmt)).toBeNull();
  });
  it('distinguishes today, overdue and upcoming by calendar-date string', () => {
    expect(dueLabel(decision({ due_date: today }), today, fmt)).toEqual({
      text: 'Due today',
      overdue: false,
    });
    expect(dueLabel(decision({ due_date: '2026-10-30' }), today, fmt)).toEqual({
      text: 'Overdue · due <2026-10-30>',
      overdue: true,
    });
    expect(dueLabel(decision({ due_date: '2026-11-05' }), today, fmt)).toEqual({
      text: 'Due <2026-11-05>',
      overdue: false,
    });
  });
});

describe('impactProvenance', () => {
  it('attributes the note to the owner and dates it by updated_at', () => {
    expect(impactProvenance(decision({ impact_note: 'recovers 2 days' }), fmt)).toBe(
      "Owner's estimate · as of <2026-10-28>",
    );
  });
  it('is null for an empty or whitespace note', () => {
    expect(impactProvenance(decision({ impact_note: '' }), fmt)).toBeNull();
    expect(impactProvenance(decision({ impact_note: '   ' }), fmt)).toBeNull();
  });
});

describe('decidedLabel', () => {
  it('dates a made decision and is null for any other status', () => {
    expect(
      decidedLabel(decision({ status: 'made', decided_at: '2026-10-30T09:00:00Z' }), fmt),
    ).toBe('Decided <2026-10-30>');
    expect(decidedLabel(decision({ decided_at: '2026-10-30T09:00:00Z' }), fmt)).toBeNull();
  });
});

describe('linkLabel', () => {
  const link = { id: 't1', project_id: 'pr1' };
  it('is null with no link', () => {
    expect(linkLabel(decision())).toBeNull();
  });
  it('names a readable task or risk', () => {
    expect(
      linkLabel(decision({ link: { ...link, kind: 'task', short_id: 'T-12', title: 'Cutover' } })),
    ).toBe('Task T-12 · Cutover');
    expect(
      linkLabel(
        decision({ link: { ...link, kind: 'risk', short_id: 'R-003', title: 'Vendor slip' } }),
      ),
    ).toBe('Risk R-003 · Vendor slip');
  });
  it('discloses an unreadable link by kind only', () => {
    expect(
      linkLabel(decision({ link: { ...link, kind: 'task', short_id: null, title: null } })),
    ).toBe("Task in a project you're not a member of");
  });
});

describe('decisionWriteAccess', () => {
  it('lets Team Member and up write on an open program', () => {
    expect(decisionWriteAccess({ my_role: 100, is_closed: false })).toBe('write');
    expect(decisionWriteAccess({ my_role: 400, is_closed: false })).toBe('write');
  });
  it('is closed for a writer on a closed program, not write', () => {
    expect(decisionWriteAccess({ my_role: 400, is_closed: true })).toBe('closed');
  });
  it('gives a Viewer, a non-member or an unloaded program no rights', () => {
    expect(decisionWriteAccess({ my_role: 1, is_closed: false })).toBe('none');
    expect(decisionWriteAccess({ my_role: 1, is_closed: true })).toBe('none');
    expect(decisionWriteAccess({ my_role: null, is_closed: false })).toBe('none');
    expect(decisionWriteAccess(undefined)).toBe('none');
  });
});
