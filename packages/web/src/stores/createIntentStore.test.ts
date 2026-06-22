/**
 * Tests for the create-intent store (ADR-0131, #1179; coverage backfill #784).
 *
 * The store is the single dispatch point for the chrome-level "+ New" flow, so
 * its open/replace/close contract is what keeps a stale intent from re-opening
 * a modal after one was consumed. The ADR-0102 sprint-safety invariant — a
 * `task` intent never carries a sprint — is pinned at the type boundary here so
 * a future field addition can't silently let "+ New task" inject into an active
 * sprint.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useCreateIntentStore, type CreateIntent } from './createIntentStore';

describe('useCreateIntentStore', () => {
  beforeEach(() => {
    useCreateIntentStore.getState().close();
  });

  it('starts with no intent', () => {
    expect(useCreateIntentStore.getState().intent).toBeNull();
  });

  it('open publishes the intent', () => {
    const intent: CreateIntent = { kind: 'task', projectId: 'p1' };
    useCreateIntentStore.getState().open(intent);
    expect(useCreateIntentStore.getState().intent).toEqual(intent);
  });

  it('open replaces a prior, unconsumed intent rather than queueing', () => {
    useCreateIntentStore.getState().open({ kind: 'task', projectId: 'p1' });
    useCreateIntentStore.getState().open({ kind: 'project', programId: 'prog1' });
    expect(useCreateIntentStore.getState().intent).toEqual({ kind: 'project', programId: 'prog1' });
  });

  it('close clears the intent (modal close / view consumed it)', () => {
    useCreateIntentStore.getState().open({ kind: 'story', projectId: 'p1' });
    useCreateIntentStore.getState().close();
    expect(useCreateIntentStore.getState().intent).toBeNull();
  });

  it('a task intent never carries a sprint field (ADR-0102 sprint-safety)', () => {
    const intent: CreateIntent = { kind: 'task', projectId: 'p1', isMilestone: true };
    useCreateIntentStore.getState().open(intent);
    const published = useCreateIntentStore.getState().intent!;
    // The deliberate path is the user picking the active sprint inside the form;
    // the intent must not smuggle one in. Guard the shape, not just the type.
    expect(Object.keys(published)).not.toContain('sprint');
    expect(Object.keys(published)).not.toContain('sprintId');
  });
});
