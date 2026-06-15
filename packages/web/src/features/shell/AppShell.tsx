import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '@/lib/queryClient';
import { TopBar } from './TopBar';
import { ContextBar } from './ContextBar';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { BottomNav } from './BottomNav';
import { SessionExpiredBanner } from './SessionExpiredBanner';
import { OfflineBanner } from './OfflineBanner';
import { CommandPalette } from './commandPalette/CommandPalette';
import { useCommandPaletteHotkey } from './commandPalette/useCommandPaletteHotkey';
import { useSidebarCollapseHotkey } from './useSidebarCollapseHotkey';
import { CreateDispatcher } from './CreateDispatcher';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // ⌘K / Ctrl+K opens the command palette from anywhere (v2 design system).
  useCommandPaletteHotkey();
  // ⌘B / Ctrl+B toggles the sidebar rail (v2 collapse affordance, ADR-0127).
  useSidebarCollapseHotkey();

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Return focus to hamburger button after drawer closes (WCAG 2.1 §2.4.3)
    hamburgerRef.current?.focus();
  }, []);

  // When the API or WS interceptors mark the session expired, cancel any
  // in-flight queries so they don't continue to populate the cache after
  // the tokens were cleared. The actual UI surface (banner + Sign-in CTA)
  // is rendered by `<SessionExpiredBanner>`; we deliberately do NOT
  // auto-navigate to `/login` because that drops the user into a screen
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
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Skip link (WCAG 2.4.1 Bypass Blocks) — first focusable element; lets
            keyboard users jump past the sidebar/topbar straight to content. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-brand-primary focus:px-3 focus:py-2 focus:text-sm focus:text-white focus-visible:ring-2 focus-visible:ring-white"
        >
          Skip to main content
        </a>
        {/* Top bar — full width */}
        <TopBar onHamburgerClick={openDrawer} />

        {/* Proactive offline indicator (WCAG 4.1.3) — renders only when offline */}
        <OfflineBanner />

        {/* Context row (v2 shell slice 2, ADR-0127) — wayfinding + rail re-open ≡
            + theme. Sits above the body so it spans the full width. */}
        <ContextBar />

        {/* Body row: sidebar + main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — hidden below md, shown as in-flow panel from md+ */}
          <div className="hidden md:flex">
            <Sidebar />
          </div>

          {/* Main content area — neutral-surface, not chrome-surface.
              Chrome surface is reserved for navigation shell (sidebar, topbar).
              Content views render on the lighter neutral-surface background. */}
          <main id="main-content" className="flex-1 min-w-0 overflow-auto bg-neutral-surface">
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
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
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

      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
