import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useShellStore } from '@/stores/shellStore';
import { methodologyLabel } from '@/lib/methodologyLabel';
import type { Methodology } from '@/types';

// Compact 2-letter methodology code — the visual shorthand restored from the
// original #1469 badge. Never the sole signal (see `aria-label` below).
const METHOD_CODE: Record<Methodology, string> = {
  AGILE: 'AG',
  WATERFALL: 'WF',
  HYBRID: 'HY',
};

// Outlined chip in the mono/secondary token family (rule 36/101), matching the
// Sidebar's ⌘K kbd chip (rounded-chip + chrome-border/20) — no new colors.
const BADGE_CLASS =
  'hidden md:inline-flex self-center items-center rounded-chip border border-chrome-border/20 px-1.5 py-0.5 text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary select-none';

/**
 * Always-visible methodology indicator in the TopBar (issue #1907). Restores the
 * signal #1469 added after the #1680 shell redesign relocated it to the left-rail
 * "This project" card subtitle (`Sidebar.tsx` `ProjectViewsTier`) — a subtitle that
 * only renders while the rail is expanded. The rail auto-collapses below 1023px
 * (ADR-0127) unless the user has manually pinned it open, which left the
 * 768–1023px band with no at-a-glance Waterfall/Agile/Hybrid signal on a fresh
 * session — exactly the gap #1469 originally closed.
 *
 * Gated on `sidebarCollapsed` rather than a fixed viewport breakpoint: it renders
 * only while the rail is collapsed, so the methodology is identifiable *somewhere*
 * at every width from md (768px) up, and it never doubles up with the rail
 * subtitle when the rail is open (whether that's the ≥1024px default or a
 * manually-pinned rail at any width) — the #1907 no-duplication requirement.
 * Below md the bottom nav takes over and the rail lives in the hamburger drawer,
 * matching the original #1469 gate.
 *
 * `role="img"` + `aria-label` carries the accessible name as the full methodology
 * word ("Hybrid workspace", etc.) — the two letters are a visual shorthand only,
 * never the sole signal (WCAG 1.4.1, rule 6).
 */
export function MethodologyIndicator() {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);

  if (!projectId || !sidebarCollapsed) return null;

  // Server-resolved preset (web-rule 196) — the same value the rail subtitle
  // reads, so the two surfaces can never drift on which methodology is "current".
  const methodology = project.data?.effective_methodology ?? 'HYBRID';
  const label = methodologyLabel(methodology);

  return (
    <span role="img" aria-label={`${label} workspace`} className={BADGE_CLASS}>
      {METHOD_CODE[methodology]}
    </span>
  );
}
