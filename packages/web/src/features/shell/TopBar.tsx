import { useShellStore } from '@/stores/shellStore';
import { useShellStats } from '@/hooks/useShellStats';
import { Logo } from './Logo';
import { ViewTabs } from './ViewTabs';

interface Props {
  onHamburgerClick: () => void;
}

export function TopBar({ onHamburgerClick }: Props) {
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const { data: stats } = useShellStats();

  return (
    <header className="flex items-center h-12 px-4 gap-4 bg-neutral-surface-raised border-b border-neutral-border">
      {/* Hamburger — visible only below md */}
      <button
        type="button"
        onClick={onHamburgerClick}
        aria-label="Open sidebar"
        aria-expanded={!sidebarCollapsed}
        className="md:hidden flex items-center justify-center w-8 h-8 rounded text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <rect y="3" width="20" height="2" rx="1" />
          <rect y="9" width="20" height="2" rx="1" />
          <rect y="15" width="20" height="2" rx="1" />
        </svg>
      </button>

      <Logo />
      <ViewTabs />

      {/* Badges — pushed to the right */}
      <div className="ml-auto flex items-center gap-2">
        {stats?.monteCarlop80 && (
          <span
            className="hidden xl:flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium
              bg-brand-accent-light text-brand-accent-dark"
            aria-label={`Monte Carlo P80: ${stats.monteCarlop80}`}
          >
            P80: {new Date(stats.monteCarlop80).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
        {stats && stats.atRiskCount > 0 && (
          <span
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium
              bg-semantic-at-risk/10 text-semantic-at-risk"
            aria-label={`${stats.atRiskCount} tasks at risk`}
          >
            ⚠ {stats.atRiskCount}
          </span>
        )}
        {stats && stats.criticalCount > 0 && (
          <span
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium
              bg-semantic-critical/10 text-semantic-critical"
            aria-label={`${stats.criticalCount} critical tasks`}
          >
            ● {stats.criticalCount}
          </span>
        )}

        {/* User avatar — menu deferred to auth feature */}
        <button
          type="button"
          aria-label="User menu"
          aria-haspopup="menu"
          className="flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold
            bg-brand-primary-light text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          U
        </button>
      </div>
    </header>
  );
}
