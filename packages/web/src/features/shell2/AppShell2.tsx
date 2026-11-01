import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '@/lib/queryClient';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useShellStore } from '@/stores/shellStore';
import { useShortcutsModalStore } from '@/stores/shortcutsModalStore';
import { useHelpShortcut } from '@/hooks/useHelpShortcut';
import { useBlockerOffline } from '@/features/blocker/offline/useBlockerOffline';
import { ToastHost } from '@/components/Toast';
import { EmptyStateAnnouncer } from '@/components/EmptyStateAnnouncer';
import {
  SessionExpiredBanner,
  SessionExpiredReadOnlyBar,
} from '@/features/shell/SessionExpiredBanner';
import { DemoModeBar } from '@/features/shell/DemoModeBar';
import { PendingWritesGuard } from '@/features/shell/PendingWritesGuard';
import { StartExploringCallout } from '@/features/shell/StartExploringCallout';
import { CommandPalette } from '@/features/shell/commandPalette/CommandPalette';
import { LastTaskRecorder } from '@/features/shell/commandPalette/LastTaskRecorder';
import { useCommandPaletteHotkey } from '@/features/shell/commandPalette/useCommandPaletteHotkey';
import { useSidebarCollapseHotkey } from '@/features/shell/useSidebarCollapseHotkey';
import { SettingsHotkey } from '@/features/shell/useSettingsHotkey';
import { PinMigration } from '@/features/shell/PinMigration';
import { FeedbackDialogHost } from '@/features/shell/FeedbackDialogHost';
import { KeyboardShortcutsModal } from '@/features/shell/KeyboardShortcutsModal';
import { CreateDispatcher } from '@/features/shell/CreateDispatcher';
import { GlobalTaskDrawer } from '@/features/shell/GlobalTaskDrawer';
import { DisplayFormatSync } from '@/features/shell/DisplayFormatSync';
import { Rail2 } from './Rail2';
import { TopBar2 } from './TopBar2';
import { ContextHeader2 } from './ContextHeader2';
import { BottomBar2 } from './BottomBar2';
import { useMinWidth } from './useMinWidth';

/** The rail expands at and above this width; below it is the 64px icon rail with the Work flyout. */
const RAIL_EXPAND_MIN_WIDTH = 1280;

/**
 * Shell v2 (Pass 1 redesign), mounted in place of `AppShell` when the
 * `shell_v2` flag is on. Same route tree, same overlay hosts, same hotkeys —
 * only the chrome changes: a 5-item rail, one breadcrumb, one status slot,
 * and a context header with a ≤5-tab row instead of a 14-row sidebar and four
 * stackable banners.
 *
 * Breakpoints are the shell's alone: `< md` gets the phone bar, `md`–1279 the
 * icon rail, `≥ 1280` the expanded rail (unless the person collapsed it).
 * Everything inside the sheet queries its own container, not the viewport.
 */
export function AppShell2() {
  const bp = useBreakpoint();
  const wide = useMinWidth(RAIL_EXPAND_MIN_WIDTH);
  const userCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const collapsed = !wide || userCollapsed;

  useCommandPaletteHotkey();
  useSidebarCollapseHotkey();
  const openShortcutsModal = useShortcutsModalStore((s) => s.openModal);
  const shortcutsModalOpen = useShortcutsModalStore((s) => s.open);
  const closeShortcutsModal = useShortcutsModalStore((s) => s.closeModal);
  useHelpShortcut(openShortcutsModal);
  useBlockerOffline();

  // Same session-expiry handling as `AppShell`: stop in-flight queries from
  // repopulating the cache after the tokens were cleared.
  useEffect(() => {
    const handler = () => {
      void queryClient.cancelQueries();
    };
    window.addEventListener('auth:sessionExpired', handler);
    return () => window.removeEventListener('auth:sessionExpired', handler);
  }, []);

  const phone = bp === 'sm';

  return (
    <QueryClientProvider client={queryClient}>
      <DisplayFormatSync />
      <SettingsHotkey />
      <PinMigration />
      <FeedbackDialogHost />
      <EmptyStateAnnouncer />
      <div
        data-testid="shell2"
        className="flex h-screen overflow-hidden bg-p1-surface-0 font-display text-sm text-p1-text-1 antialiased"
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:bg-p1-brand focus:px-3 focus:py-2 focus:text-sm focus:text-p1-on-brand focus:ring-2 focus:ring-p1-focus"
        >
          Skip to main content
        </a>

        {/* One copy of the primary navigation per breakpoint (rule 211). */}
        {!phone && <Rail2 collapsed={collapsed} canExpand={wide} />}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* The sheet: inset 8px from the canvas, radius 10, container-queried. */}
          <div
            className={[
              'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-p1-surface-1 [container:main/inline-size]',
              phone ? '' : 'my-2 mr-2 rounded-[10px] border border-p1-hairline',
            ].join(' ')}
          >
            <TopBar2 />
            {/* The two bars that carry an ACTION stay: the signed-out bar is the only
                way back to sign-in once the modal is dismissed, and the demo bar holds
                the demo project switcher and reset line. The status-only banners
                (offline, rate-limit) and the sync badge are folded into the status slot. */}
            <SessionExpiredReadOnlyBar />
            <DemoModeBar />
            <ContextHeader2 />
            <main
              id="main-content"
              tabIndex={-1}
              className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
            >
              <StartExploringCallout />
              <Outlet />
            </main>
          </div>
          {phone && <BottomBar2 />}
        </div>
      </div>

      <PendingWritesGuard />
      <SessionExpiredBanner />
      <CommandPalette />
      <LastTaskRecorder />
      <CreateDispatcher />
      <GlobalTaskDrawer />
      {shortcutsModalOpen && <KeyboardShortcutsModal onClose={closeShortcutsModal} />}
      <ToastHost />
      {import.meta.env.DEV && import.meta.env.VITE_REACT_QUERY_DEVTOOLS === 'true' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
