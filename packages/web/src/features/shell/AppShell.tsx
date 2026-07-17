import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '@/lib/queryClient';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { BottomNav } from './BottomNav';
import { SessionExpiredBanner, SessionExpiredReadOnlyBar } from './SessionExpiredBanner';
import { OfflineBanner } from './OfflineBanner';
import { PendingWritesGuard } from './PendingWritesGuard';
import { StartExploringCallout } from './StartExploringCallout';
import { CommandPalette } from './commandPalette/CommandPalette';
import { useCommandPaletteHotkey } from './commandPalette/useCommandPaletteHotkey';
import { useSidebarCollapseHotkey } from './useSidebarCollapseHotkey';
import { useHelpShortcut } from '@/hooks/useHelpShortcut';
import { useShortcutsModalStore } from '@/stores/shortcutsModalStore';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { CreateDispatcher } from './CreateDispatcher';
import { GlobalTaskDrawer } from './GlobalTaskDrawer';
import { ToastHost } from '@/components/Toast';
import { DisplayFormatSync } from './DisplayFormatSync';
import { useBlockerOffline } from '@/features/blocker/offline/useBlockerOffline';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // ⌘K / Ctrl+K opens the command palette from anywhere (v2 design system).
  useCommandPaletteHotkey();
  // ⌘B / Ctrl+B toggles the sidebar rail (v2 collapse affordance, ADR-0127).
  useSidebarCollapseHotkey();
  // `?` opens the app-wide keyboard-shortcuts modal from anywhere (#2058). It
  // yields to a surface that already binds `?` (Board / Schedule build mode).
  const openShortcutsModal = useShortcutsModalStore((s) => s.openModal);
  const shortcutsModalOpen = useShortcutsModalStore((s) => s.open);
  const closeShortcutsModal = useShortcutsModalStore((s) => s.closeModal);
  useHelpShortcut(openShortcutsModal);
  // Flush any offline-queued blocker writes on reconnect (ADR-0247). Mounted here,
  // not in the blocker drawer, so a queued flag syncs even if the drawer is closed.
  useBlockerOffline();

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Return focus to hamburger button after drawer closes (WCAG 2.1 §2.4.3)
    hamburgerRef.current?.focus();
  }, []);

  // When the API or WS interceptors mark the session expired, cancel any
  // in-flight queries so they don't continue to populate the cache after
  // the tokens were cleared. The actual UI surface (blocking modal, or the
  // persistent read-only banner once escaped — #1922) is rendered by
  // `<SessionExpiredBanner>` / `<SessionExpiredReadOnlyBar>`; we deliberately
  // do NOT auto-navigate to `/login` because that drops the user into a screen
  // with no explanation of why they were logged out (352).
  useEffect(() => {
    const handler = () => {
      void queryClient.cancelQueries();
    };
    window.addEventListener('auth:sessionExpired', handler);
    return () => window.removeEventListener('auth:sessionExpired', handler);
  }, []);

  // Close drawer on viewport resize to ≥ md
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Sync the user's date-format preference into the calendar-date formatter
          default (#1953, ADR-0410). Inside the provider — reads useCurrentUser. */}
      <DisplayFormatSync />
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Skip link (WCAG 2.4.1 Bypass Blocks) — first focusable element; lets
            keyboard users jump past the sidebar/topbar straight to content. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded-control focus:bg-brand-primary focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:ring-2 focus:ring-white"
        >
          Skip to main content
        </a>
        {/* v2 unified shell bar (ADR-0134) — one full-width bar carrying wayfinding,
            the rail re-open ≡, the scrollable view/program nav, and the right cluster.
            Supersedes the former TopBar + ContextBar two-row split. */}
        <TopBar onHamburgerClick={openDrawer} />

        {/* Persistent, non-blocking read-only notice (#1922) — renders only after
            the user escapes the blocking SessionExpiredBanner modal below. In-flow
            (not fixed) so it never covers the TopBar and stays part of the
            always-visible header region above the scrollable content. */}
        <SessionExpiredReadOnlyBar />

        {/* Proactive offline indicator (WCAG 4.1.3) — renders only when offline */}
        <OfflineBanner />

        {/* #2028: warn before a reload/close while writes are still un-drained
            (in-memory queue would be lost). Renders nothing. */}
        <PendingWritesGuard />

        {/* Body row: sidebar + main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — hidden below md, shown as in-flow panel from md+ */}
          <div className="hidden md:flex">
            <Sidebar />
          </div>

          {/* Main content area — app-canvas (warm paper), not chrome-surface.
              Chrome surface is reserved for navigation shell (sidebar, topbar).
              Content views render on the v2 app-canvas so cards (bg-neutral-surface)
              pop against it instead of disappearing into a flat white field (ADR-0126). */}
          <main id="main-content" className="flex-1 min-w-0 overflow-auto bg-app-canvas">
            {/* Non-blocking post-load guidance — renders only right after a
                sample load (reads router state), dismissable (issue 1054). */}
            <StartExploringCallout />
            <Outlet />
          </main>
        </div>

        <StatusBar />

        {/* Bottom nav rail — shown below md in place of view tabs */}
        <BottomNav />
      </div>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-neutral-overlay md:hidden"
            aria-hidden="true"
            onClick={closeDrawer}
          />
          {/* Drawer */}
          <div
            className="fixed left-0 top-0 h-full z-50 md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Project navigation"
          >
            <Sidebar isDrawer onClose={closeDrawer} />
          </div>
        </>
      )}

      <SessionExpiredBanner />

      {/* ⌘K command palette (v2 design system) — portaled overlay; renders only when open */}
      <CommandPalette />

      {/* Create-intent dispatcher (ADR-0131, 1179) — renders the modal create flow
          for the active "+ New" intent; null when none is open. */}
      <CreateDispatcher />

      {/* App-wide task drawer (ADR-0138, issue 647) — opened by the ⌘K palette so a
          task can be edited inline from any route; null until a task is set. */}
      <GlobalTaskDrawer />

      {/* App-wide keyboard-shortcuts modal (#2058) — a single instance driven by
          the shortcutsModalStore, opened by the UserMenu row and the global `?`
          hotkey (useHelpShortcut). Rendered once here so both triggers share it. */}
      {shortcutsModalOpen && <KeyboardShortcutsModal onClose={closeShortcutsModal} />}

      {/* Global toast host (ADR-0126, issue 1225) — bottom-center ink-pill stack
          for app-wide confirmations (create/complete/save/pin/theme). Board-local
          notices stay in BoardDropNotice (rule 170). */}
      <ToastHost />

      {/* The React Query devtools panel is opt-in: it occupies screen real estate,
          so it stays off unless VITE_REACT_QUERY_DEVTOOLS=true is set at build/dev
          start (restart Vite to pick it up). Gated on DEV too so the devDependency
          import is tree-shaken out of production builds. */}
      {import.meta.env.DEV && import.meta.env.VITE_REACT_QUERY_DEVTOOLS === 'true' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
