import { useShellStats } from '@/hooks/useShellStats';

function formatLastSaved(iso: string | null): string {
  if (!iso) return '—';
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'Last saved: just now';
  if (diff < 3600) return `Last saved: ${Math.floor(diff / 60)} min ago`;
  return `Last saved: ${new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

// Rule 44: four items — Complete · In progress · Critical path · ◆ Milestone
// Milestone uses the diamond character (rendered separately below).
const LEGEND = [
  { label: 'Complete', colorClass: 'bg-semantic-on-track' },
  { label: 'In progress', colorClass: 'bg-brand-primary' },
  { label: 'Critical path', colorClass: 'bg-semantic-critical' },
] as const;

export function StatusBar() {
  const { data: stats } = useShellStats();

  const p80Formatted = stats?.monteCarlop80
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
        new Date(stats.monteCarlop80),
      )
    : null;

  return (
    <footer
      role="contentinfo"
      aria-label="Project status"
      className="flex items-center h-7 px-4 gap-4 text-xs text-neutral-text-secondary
        bg-neutral-surface-raised border-t border-neutral-border overflow-hidden"
    >
      {stats ? (
        <>
          <span>{stats.taskCount} tasks</span>
          <span className="w-px h-3 bg-neutral-border" aria-hidden="true" />
          <span aria-label={`${stats.criticalPathCount} on critical path`}>
            {stats.criticalPathCount} on critical path
          </span>
          <span className="w-px h-3 bg-neutral-border" aria-hidden="true" />
          <time
            dateTime={stats.lastSaved ?? ''}
            title={stats.lastSaved ? new Date(stats.lastSaved).toLocaleString() : undefined}
          >
            {formatLastSaved(stats.lastSaved)}
          </time>
          {/* P80 chip — mobile only (<md); desktop shows full MC row. Issue #33. */}
          {p80Formatted && (
            <>
              <span className="md:hidden w-px h-3 bg-neutral-border" aria-hidden="true" />
              <span
                className="md:hidden inline-flex items-center px-1.5 py-0.5 rounded border border-semantic-at-risk/40 text-xs font-medium text-semantic-at-risk bg-transparent"
                aria-label={`Monte Carlo P80 completion: ${p80Formatted}`}
              >
                P80: {p80Formatted}
              </span>
            </>
          )}
          <span className="hidden 2xl:contents">
            <span className="w-px h-3 bg-neutral-border" aria-hidden="true" />
            <span>{stats.onlineUsers} online</span>
          </span>
        </>
      ) : (
        <span aria-live="polite">Loading…</span>
      )}

      {/* Gantt legend — right-aligned, hidden below md (rule 44) */}
      <span className="hidden md:flex ml-auto items-center gap-3" aria-label="Gantt legend">
        {LEGEND.map(({ label, colorClass }) => (
          <span key={label} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${colorClass}`} aria-hidden="true" />
            <span>{label}</span>
          </span>
        ))}
        {/* Milestone — diamond character per rule 44 */}
        <span className="flex items-center gap-1">
          <span className="text-brand-accent" aria-hidden="true">◆</span>
          <span>Milestone</span>
        </span>
      </span>
    </footer>
  );
}
