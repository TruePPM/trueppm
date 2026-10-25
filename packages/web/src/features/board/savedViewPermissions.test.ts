import { describe, it, expect } from 'vitest';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import { canCreateSavedView, canEditSavedView } from './savedViewPermissions';

describe('canEditSavedView (#4595)', () => {
  it('hides from a Viewer even when they are the creator', () => {
    expect(canEditSavedView(ROLE_VIEWER, false, 7, '7')).toBe(false);
  });
  it('shows to a Member creator, hides from a Member non-creator', () => {
    expect(canEditSavedView(ROLE_MEMBER, false, 7, '7')).toBe(true);
    expect(canEditSavedView(ROLE_MEMBER, false, 8, '7')).toBe(false);
  });
  it('shows to a Scheduler who did not create the view', () => {
    expect(canEditSavedView(ROLE_SCHEDULER, false, 8, '7')).toBe(true);
  });
  it('treats a null creator as not-the-viewer: Member hidden, Scheduler shown', () => {
    expect(canEditSavedView(ROLE_MEMBER, false, null, '7')).toBe(false);
    expect(canEditSavedView(ROLE_SCHEDULER, false, null, '7')).toBe(true);
  });
  it('hides while the role is loading', () => {
    expect(canEditSavedView(null, false, 7, '7')).toBe(false);
  });
  it('treats a failed role read as unsettled (Member assumed), never denial', () => {
    expect(canEditSavedView(null, true, 7, '7')).toBe(true);
    expect(canEditSavedView(null, true, 8, '7')).toBe(false);
  });
});

describe('canCreateSavedView (#4595)', () => {
  it('requires Member+, hides on loading, assumes Member on a failed read', () => {
    expect(canCreateSavedView(ROLE_VIEWER)).toBe(false);
    expect(canCreateSavedView(ROLE_MEMBER)).toBe(true);
    expect(canCreateSavedView(null, false)).toBe(false);
    expect(canCreateSavedView(null, true)).toBe(true);
  });
});
