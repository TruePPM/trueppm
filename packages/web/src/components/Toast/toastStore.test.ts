import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useToastStore,
  TOAST_DEFAULT_DURATION_MS,
  TOAST_ACTION_DURATION_MS,
  TOAST_COALESCE_WINDOW_MS,
  TOAST_TRAIL_CAP,
} from './toastStore';

const store = () => useToastStore.getState();
const undoable = (onClick = vi.fn()) => ({ label: 'Undo', onClick });
/** An actionable whose undo is also recorded somewhere durable, so it may be displaced. */
const backed = { trailBacked: true };

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
  });

  describe('slot assignment (#3149 D5)', () => {
    it('push puts a passive in the transient slot with info/default-duration defaults', () => {
      const id = store().push({ message: 'Saved' });
      expect(store().transient).toMatchObject({
        id,
        message: 'Saved',
        variant: 'info',
        durationMs: TOAST_DEFAULT_DURATION_MS,
        slot: 'transient',
        count: 1,
      });
      expect(store().action).toBeNull();
    });

    it('push puts an actionable in the action slot with the longer dwell', () => {
      const id = store().push({ message: 'Deleted — Cable plant', action: undoable() });
      expect(store().action).toMatchObject({
        id,
        slot: 'action',
        durationMs: TOAST_ACTION_DURATION_MS,
      });
      expect(store().transient).toBeNull();
    });

    it('honors an explicit variant and duration', () => {
      store().push({ message: 'Boom', variant: 'error', durationMs: 1000 });
      expect(store().transient).toMatchObject({ variant: 'error', durationMs: 1000 });
    });

    it('assigns a unique id to each toast', () => {
      const a = store().push({ message: 'A' });
      const b = store().push({ message: 'B' });
      expect(a).not.toBe(b);
    });
  });

  describe('the eviction table', () => {
    it('passive onto an empty stack renders in the transient slot', () => {
      store().push({ message: 'A' });
      expect(store().transient?.message).toBe('A');
      expect(store().action).toBeNull();
    });

    it('passive replaces passive in place; the outgoing dwell is discarded, not transferred', () => {
      const first = store().push({ message: 'A', durationMs: 9000 });
      const second = store().push({ message: 'B' });
      expect(store().transient?.id).toBe(second);
      expect(store().transient?.message).toBe('B');
      // The replacement carries its own clock — it does not inherit A's 9s.
      expect(store().transient?.durationMs).toBe(TOAST_DEFAULT_DURATION_MS);
      expect(first).not.toBe(second);
    });

    it('a passive NEVER displaces an action toast — different slots, both render', () => {
      const undo = store().push({ message: 'Deleted — Cable plant', action: undoable() });
      store().push({ message: 'Estimate saved' });
      store().push({ message: 'Owner set' });
      expect(store().action?.id).toBe(undo);
      expect(store().action?.action).toBeDefined();
      expect(store().transient?.message).toBe('Owner set');
    });

    it('a routine confirmation does NOT evict an unexpired passive error', () => {
      // The slot split reads actionability, but `variant` encodes importance too —
      // without this an "Estimate saved" arriving 200ms later silently eats the
      // failure notice, which is drop-oldest returning on a second axis.
      const failure = store().push({ message: 'Could not save the estimate.', variant: 'error' });
      store().push({ message: 'Owner set', variant: 'success' });
      expect(store().transient?.id).toBe(failure);
      expect(store().transient?.message).toBe('Could not save the estimate.');
    });

    it('another error DOES replace a passive error', () => {
      store().push({ message: 'First failure', variant: 'error' });
      const second = store().push({ message: 'Second failure', variant: 'error' });
      expect(store().transient?.id).toBe(second);
    });

    it('a confirmation takes the slot once the error has outlived its dwell', () => {
      vi.useFakeTimers();
      try {
        useToastStore.getState().clear();
        store().push({ message: 'Could not save.', variant: 'error', durationMs: 1000 });
        vi.advanceTimersByTime(1001);
        store().push({ message: 'Owner set', variant: 'success' });
        expect(store().transient?.message).toBe('Owner set');
      } finally {
        vi.useRealTimers();
      }
    });

    it('an action toast never touches the transient slot', () => {
      const passive = store().push({ message: 'Estimate saved' });
      store().push({ message: 'Deleted — Cable plant', action: undoable() });
      expect(store().transient?.id).toBe(passive);
      expect(store().transient?.durationMs).toBe(TOAST_DEFAULT_DURATION_MS);
    });

    it('caps at two however many arrive — the cap is structural, not a loop', () => {
      for (let i = 0; i < 10; i += 1) {
        store().push({ message: `passive ${i}` });
        store().push({ message: `action ${i}`, action: undoable(), ...backed });
      }
      const rendered = [store().transient, store().action].filter(Boolean);
      expect(rendered).toHaveLength(2);
      expect(store().transient?.message).toBe('passive 9');
      expect(store().action?.message).toBe('action 9');
    });

    it('an incoming action takes the slot; the displaced one demotes to the trail with its action intact', () => {
      const firstUndo = vi.fn();
      const displaced = store().push({
        message: 'Deleted — Cable plant',
        action: undoable(firstUndo),
        ...backed,
      });
      const incoming = store().push({
        message: 'Deleted — Trenching',
        action: undoable(),
        ...backed,
      });

      expect(store().action?.id).toBe(incoming);
      expect(store().trail).toHaveLength(1);
      expect(store().trail[0].id).toBe(displaced);
      // D6: eviction may cost convenience, never capability — the undo still runs.
      store().trail[0].action?.onClick();
      expect(firstUndo).toHaveBeenCalledOnce();
    });

    it('a NON-trail-backed action toast is never displaced — the incoming queues instead', () => {
      // D6 only permits eviction where the loser's undo survives the pill. Default
      // is not-backed, which is every global action toast in the tree today.
      const onScreen = store().push({ message: 'Deleted — Cable plant', action: undoable() });
      const incoming = store().push({ message: 'Deleted — Trenching', action: undoable() });

      expect(store().action?.id).toBe(onScreen);
      expect(store().pending?.id).toBe(incoming);
      // Nothing was evicted, so nothing was stranded in the inert trail either.
      expect(store().trail).toHaveLength(0);
    });

    it('the queued toast lands once the un-backed one on screen is dismissed', () => {
      const onScreen = store().push({ message: 'Deleted — Cable plant', action: undoable() });
      const incoming = store().push({ message: 'Deleted — Trenching', action: undoable() });

      store().dismiss(onScreen);
      expect(store().action?.id).toBe(incoming);
      expect(store().pending).toBeNull();
    });

    it('trail-backing is read off the toast being displaced, not the incoming one', () => {
      // The question D6 asks is "will the loser's undo survive?", so it is the
      // outgoing toast's property that decides — an incoming backed toast must not
      // license the eviction of an unbacked one.
      const unbacked = store().push({ message: 'Unbacked', action: undoable() });
      store().push({ message: 'Backed incoming', action: undoable(), ...backed });
      expect(store().action?.id).toBe(unbacked);
      expect(store().pending?.message).toBe('Backed incoming');
    });

    it('the demotion trail is capped, oldest first off the end', () => {
      for (let i = 0; i < TOAST_TRAIL_CAP + 4; i += 1) {
        store().push({ message: `action ${i}`, action: undoable(), ...backed });
      }
      expect(store().trail).toHaveLength(TOAST_TRAIL_CAP);
      // 14 pushed, the newest holds the slot, so 13 demoted and the first 3 fell off.
      expect(store().trail[0].message).toBe('action 3');
      expect(store().trail.at(-1)?.message).toBe('action 12');
    });
  });

  describe('focus protection (#3149 D8)', () => {
    it('a toast with focus inside it is NOT displaced — the incoming waits', () => {
      const held = store().push({
        message: 'Deleted — Cable plant',
        action: undoable(),
        ...backed,
      });
      store().setFocusWithin(held, true);
      const incoming = store().push({
        message: 'Deleted — Trenching',
        action: undoable(),
        ...backed,
      });

      expect(store().action?.id).toBe(held);
      expect(store().pending?.id).toBe(incoming);
      // Nothing was evicted, so nothing demoted.
      expect(store().trail).toHaveLength(0);
    });

    it('the queue is depth one — a second arrival replaces the waiting one, which demotes', () => {
      const held = store().push({ message: 'Held', action: undoable(), ...backed });
      store().setFocusWithin(held, true);
      const firstWaiter = store().push({ message: 'Waiter one', action: undoable(), ...backed });
      const secondWaiter = store().push({ message: 'Waiter two', action: undoable(), ...backed });

      expect(store().action?.id).toBe(held);
      expect(store().pending?.id).toBe(secondWaiter);
      // The waiter that lost never painted, but its capability still survives.
      expect(store().trail.map((t) => t.id)).toEqual([firstWaiter]);
    });

    it('releases the queued toast when focus leaves, demoting the one it waited on', () => {
      const held = store().push({ message: 'Held', action: undoable(), ...backed });
      store().setFocusWithin(held, true);
      const waiter = store().push({ message: 'Waiter', action: undoable(), ...backed });

      store().setFocusWithin(held, false);
      expect(store().action?.id).toBe(waiter);
      expect(store().pending).toBeNull();
      expect(store().focusedId).toBeNull();
      expect(store().trail.map((t) => t.id)).toEqual([held]);
    });

    it('releases the queued toast when the held one is dismissed (Undo pressed)', () => {
      const held = store().push({ message: 'Held', action: undoable(), ...backed });
      store().setFocusWithin(held, true);
      const waiter = store().push({ message: 'Waiter', action: undoable(), ...backed });

      store().dismiss(held);
      expect(store().action?.id).toBe(waiter);
      expect(store().pending).toBeNull();
      expect(store().focusedId).toBeNull();
    });

    it('dismissing the queued toast clears it and normalizes the focus claim', () => {
      const held = store().push({ message: 'Held', action: undoable(), ...backed });
      store().setFocusWithin(held, true);
      const waiter = store().push({ message: 'Waiter', action: undoable(), ...backed });

      store().dismiss(waiter);
      expect(store().pending).toBeNull();
      // The held toast keeps the slot and keeps its claim — dismissing the waiter
      // must not release the protection the held one earned.
      expect(store().action?.id).toBe(held);
      expect(store().focusedId).toBe(held);
    });

    it('blur does NOT release the queue when the toast on screen is un-backed', () => {
      // Losing focus removes the D8 reason to wait; it does not create a durable
      // home for an undo that never had one. Promoting here would perform exactly
      // the eviction the push path refused.
      const held = store().push({ message: 'Un-backed', action: undoable() });
      store().setFocusWithin(held, true);
      store().push({ message: 'Waiter', action: undoable() });

      store().setFocusWithin(held, false);
      expect(store().action?.id).toBe(held);
      expect(store().pending?.message).toBe('Waiter');
      expect(store().trail).toHaveLength(0);
      expect(store().focusedId).toBeNull();
    });

    it('focus leaving a toast that never held the claim changes nothing', () => {
      const held = store().push({ message: 'Held', action: undoable(), ...backed });
      store().setFocusWithin(held, true);
      store().setFocusWithin('toast-does-not-exist', false);
      expect(store().focusedId).toBe(held);
    });
  });

  describe('coalescing identical passives', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      useToastStore.getState().clear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('absorbs an identical passive inside the window: same pill, count suffix, restarted clock', () => {
      const first = store().push({ message: 'Estimate saved' });
      const revisionBefore = store().transient?.revision;
      vi.advanceTimersByTime(200);
      const second = store().push({ message: 'Estimate saved' });
      vi.advanceTimersByTime(200);
      store().push({ message: 'Estimate saved' });

      // Same id means the host keeps the React key: no remount, no replayed entrance.
      expect(second).toBe(first);
      expect(store().transient?.id).toBe(first);
      expect(store().transient?.count).toBe(3);
      expect(store().transient?.revision).toBeGreaterThan(revisionBefore ?? 0);
    });

    it('a coalesce keeps the LONGER dwell — it restarts a window, never shortens one', () => {
      store().push({ message: 'Estimate saved', durationMs: 9000 });
      vi.advanceTimersByTime(200);
      store().push({ message: 'Estimate saved' });
      expect(store().transient?.count).toBe(2);
      expect(store().transient?.durationMs).toBe(9000);
    });

    it('does not coalesce once the window has passed', () => {
      const first = store().push({ message: 'Estimate saved' });
      vi.advanceTimersByTime(TOAST_COALESCE_WINDOW_MS + 1);
      const second = store().push({ message: 'Estimate saved' });
      expect(second).not.toBe(first);
      expect(store().transient?.count).toBe(1);
    });

    it('does not coalesce across variants or messages', () => {
      store().push({ message: 'Estimate saved', variant: 'success' });
      store().push({ message: 'Estimate saved', variant: 'error' });
      expect(store().transient?.count).toBe(1);
      expect(store().transient?.variant).toBe('error');
    });

    it('leaves an uncoalesced toast at a count of one', () => {
      store().push({ message: 'Estimate saved' });
      expect(store().transient?.count).toBe(1);
    });
  });

  describe('dismiss and clear', () => {
    it('dismiss removes only the matching slot', () => {
      const passive = store().push({ message: 'Estimate saved' });
      const actionable = store().push({ message: 'Deleted', action: undoable() });
      store().dismiss(passive);
      expect(store().transient).toBeNull();
      expect(store().action?.id).toBe(actionable);
    });

    it('dismissing an id that no longer holds a slot is a no-op', () => {
      const displaced = store().push({
        message: 'Deleted — Cable plant',
        action: undoable(),
        ...backed,
      });
      const current = store().push({
        message: 'Deleted — Trenching',
        action: undoable(),
        ...backed,
      });
      store().dismiss(displaced);
      expect(store().action?.id).toBe(current);
    });

    it('clear empties both slots, the queue and the trail', () => {
      store().push({ message: 'A' });
      store().push({ message: 'Deleted', action: undoable(), ...backed });
      store().push({ message: 'Deleted again', action: undoable(), ...backed });
      store().clear();
      expect(store().transient).toBeNull();
      expect(store().action).toBeNull();
      expect(store().pending).toBeNull();
      expect(store().trail).toHaveLength(0);
      expect(store().focusedId).toBeNull();
    });

    it('carries an optional action through push (#1113 Undo)', () => {
      const onClick = vi.fn();
      store().push({
        message: '"Downtown Retrofit" moved to Trash',
        action: { label: 'Undo', onClick, ariaLabel: 'Undo — restore Downtown Retrofit' },
      });
      const stored = store().action;
      expect(stored?.action?.label).toBe('Undo');
      stored?.action?.onClick();
      expect(onClick).toHaveBeenCalledOnce();
    });
  });
});
