/**
 * Fetches the initial presence list for a project on mount and keeps the
 * presenceStore up-to-date.  Real-time updates (join/leave) arrive via the
 * WebSocket handled by useProjectWebSocket, which writes directly to the store.
 *
 * Returns the sorted list of currently-online users.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { usePresenceStore, type PresenceUser } from '@/stores/presenceStore';

async function fetchPresence(projectId: string): Promise<PresenceUser[]> {
  const resp = await apiClient.get<PresenceUser[]>(`/projects/${projectId}/presence/`);
  return resp.data;
}

export function useProjectPresence(projectId: string | null | undefined): PresenceUser[] {
  const setUsers = usePresenceStore((s) => s.setUsers);
  const users = usePresenceStore((s) => s.users);

  const { data } = useQuery({
    queryKey: ['presence', projectId],
    queryFn: () => fetchPresence(projectId!),
    enabled: Boolean(projectId),
    // Presence is refreshed in real-time via WebSocket; stale-time keeps the
    // REST call from running on every focus/mount.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Seed the store with the REST response on first load.
  useEffect(() => {
    if (data) {
      setUsers(data);
    }
  }, [data, setUsers]);

  return Object.values(users).sort((a, b) => a.display_name.localeCompare(b.display_name));
}
