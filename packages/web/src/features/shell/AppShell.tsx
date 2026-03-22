import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from '@/lib/queryClient';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { BottomNav } from './BottomNav';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Return focus to hamburger button after drawer closes (WCAG 2.1 §2.4.3)
    hamburgerRef.current?.focus();
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
        {/* Top bar — full width */}
        <TopBar onHamburgerClick={openDrawer} />

        {/* Body row: sidebar + main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — hidden below md, shown as in-flow panel from md+ */}
          <div className="hidden md:flex">
            <Sidebar />
          </div>

          {/* Main content area */}
          <main className="flex-1 min-w-0 overflow-auto bg-neutral-surface">
            <Outlet />
          </main>
        </div>

        {/* Status bar — pinned to bottom, hidden below md */}
        <div className="hidden md:block">
          <StatusBar />
        </div>

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
          <div className="fixed left-0 top-0 h-full z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Projects">
            <Sidebar isDrawer onClose={closeDrawer} />
          </div>
        </>
      )}

      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
