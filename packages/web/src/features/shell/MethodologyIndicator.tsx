import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useShellStore } from '@/stores/shellStore';
import { methodologyStatusLabel } from '@/lib/methodologyLabel';
import { Tooltip } from '@/components/Tooltip';
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
 * phrase (`methodologyStatusLabel`, e.g. "Hybrid methodology" or "Waterfall
 * methodology (workspace default)") — the two letters are a visual shorthand
 * only, never the sole signal (WCAG 1.4.1, rule 6). The phrase never says
 * "workspace" as a bare suffix (issue #2619) — that wording described the
 * *workspace's* methodology when the badge always renders this specific
 * *project's* resolved value, which can differ from the org default by
 * inheritance the project never explicitly touched.
 *
 * That label alone used to be the *whole* story, which meant a screen-reader user
 * heard only the bare methodology word and a sighted mouse user was left staring
 * at two undecodable letters (#2389). The `Tooltip` wrapper surfaces the same
 * string on hover, keyboard focus, and tap. `describe={false}` because the
 * tooltip text and the `aria-label` are the same sentence — wiring
 * `aria-describedby` as well would announce it twice.
 */
export function MethodologyIndicator() {
  const projectId = useProjectId();
  const project = useProject(projectId);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);

  if (!projectId || !sidebarCollapsed) return null;

  // Server-resolved preset (web-rule 196) — the same value the rail subtitle
  // reads, so the two surfaces can never drift on which methodology is "current".
  const methodology = project.data?.effective_methodology ?? 'HYBRID';
  const statusLabel = methodologyStatusLabel(methodology, project.data?.inherited_methodology);

  return (
    <Tooltip content={statusLabel} describe={false}>
      <span role="img" aria-label={statusLabel} className={BADGE_CLASS}>
        {METHOD_CODE[methodology]}
      </span>
    </Tooltip>
  );
}
