import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';

/**
 * Global ⌘, / Ctrl+, listener that opens Settings — the universal OS
 * "preferences" convention, so Settings is always findable without hunting the
 * avatar menu (#2298). Mounted once at the shell.
 *
 * ROLE-AWARE, mirroring the sidebar gear: a workspace admin lands on the
 * workspace `/settings` hub; everyone else lands on their personal settings, so
 * the shortcut never dumps a member onto an admin route `RequireAdminSettings`
 * would bounce. The chord is a deliberate meta/ctrl combo (not a bare key), so it
 * works even while a text input is focused and needs no typing guard; we
 * `preventDefault` only to suppress any browser default for the chord.
 */
export function useSettingsHotkey(): void {
  const navigate = useNavigate();
  const isWorkspaceAdmin = useIsWorkspaceAdmin() === true;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        void navigate(isWorkspaceAdmin ? '/settings' : '/me/settings/general');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, isWorkspaceAdmin]);
}

/**
 * Component wrapper that mounts {@link useSettingsHotkey}. Rendered INSIDE the
 * `QueryClientProvider` (not called from AppShell's top-level body), because the
 * hook reads `useIsWorkspaceAdmin` → `useCurrentUser` (react-query); calling it
 * above the provider throws "No QueryClient set". Mirrors `<DisplayFormatSync />`.
 */
export function SettingsHotkey(): null {
  useSettingsHotkey();
  return null;
}
