/**
 * Tracks which users are currently connected to a project's WebSocket.
 * State is populated by useProjectWebSocket on presence.join / presence.leave events
 * and by the initial REST fetch in useProjectPresence.
 */
import { create } from 'zustand';

export interface PresenceUser {
  user_id: string;
  display_name: string;
}

interface PresenceState {
  /** Users currently online, keyed by user_id for O(1) join/leave. */
  users: Record<string, PresenceUser>;
  /** Replace the entire presence set (called on initial REST fetch). */
  setUsers: (users: PresenceUser[]) => void;
  /** Add or refresh a user (called on presence.join). */
  addUser: (user: PresenceUser) => void;
  /** Remove a user (called on presence.leave). */
  removeUser: (userId: string) => void;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  users: {},

  setUsers: (users) => {
    const byId = Object.fromEntries(users.map((u) => [u.user_id, u]));
    set({ users: byId });
  },

  addUser: (user) =>
    set((state) => ({
      users: { ...state.users, [user.user_id]: user },
    })),

  removeUser: (userId) =>
    set((state) => {
      const next = { ...state.users };
      delete next[userId];
      return { users: next };
    }),
}));
