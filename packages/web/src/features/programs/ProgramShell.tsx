import { Outlet, useMatch } from 'react-router';

/**
 * /programs/:programId — minimal layout shell (ADR-0095).
 *
 * Program navigation (Overview · Backlog · Projects · Schedule · Resources ·
 * Members · Assets · Settings) lives in the left rail's "This program" tier
 * (`Sidebar.tsx`), mirroring how the project views live in its "This project"
 * tier — so this shell adds no in-content chrome (no header, no second tab
 * strip). That keeps the program's settings sub-pages top-aligned and makes
 * settings reachable from a Settings tab, consistent with projects. Program
 * delete lives at Settings → Archive/Close; the program name shows in the left
 * sidebar and in each view's own content.
 *
 * Settings sub-pages run the shared `SettingsShell`, which owns its own scroll
 * region (sticky context switcher + scrollable body), so they mount in a
 * non-scrolling `min-h-0 overflow-hidden` box mirroring `ProjectShell` (the
 * settings layout fix from #776 is preserved — there is simply no longer any
 * in-content chrome to suppress, only the scroll container differs). Other
 * program views scroll the outer container.
 */
export function ProgramShell() {
  const isSettingsRoute = useMatch('/programs/:programId/settings/*') != null;
  return (
    <div className="flex h-full flex-col bg-neutral-surface">
      <div
        className={isSettingsRoute ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 overflow-y-auto'}
      >
        <Outlet />
      </div>
    </div>
  );
}
