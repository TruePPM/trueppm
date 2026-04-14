import { describe, it, expect, beforeEach } from 'vitest';
import { usePresenceStore } from './presenceStore';

beforeEach(() => {
  usePresenceStore.setState({ users: {} });
});

const U1 = { user_id: '1', display_name: 'Alice' };
const U2 = { user_id: '2', display_name: 'Bob' };

describe('presenceStore', () => {
  it('starts empty', () => {
    expect(usePresenceStore.getState().users).toEqual({});
  });

  it('setUsers replaces the entire set', () => {
    usePresenceStore.getState().addUser(U1);
    usePresenceStore.getState().setUsers([U2]);
    const { users } = usePresenceStore.getState();
    expect(users).toEqual({ '2': U2 });
  });

  it('addUser inserts or refreshes a user', () => {
    usePresenceStore.getState().addUser(U1);
    usePresenceStore.getState().addUser({ user_id: '1', display_name: 'Alice Renamed' });
    expect(usePresenceStore.getState().users['1'].display_name).toBe('Alice Renamed');
  });

  it('removeUser deletes by id and is a no-op if absent', () => {
    usePresenceStore.getState().setUsers([U1, U2]);
    usePresenceStore.getState().removeUser('1');
    expect(usePresenceStore.getState().users).toEqual({ '2': U2 });
    usePresenceStore.getState().removeUser('missing');
    expect(usePresenceStore.getState().users).toEqual({ '2': U2 });
  });
});
