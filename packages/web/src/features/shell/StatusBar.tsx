import { useShellStats } from '@/hooks/useShellStats';

function formatRelativeTime(iso: string): string {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
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
            Last saved: {stats.lastSaved ? formatRelativeTime(stats.lastSaved) : '—'}
          </time>
          {/* CPM recalculation time is separate from data-entry save (rule 45) */}
          {stats.recalculatedAt && (
            <>
              <span className="w-px h-3 bg-neutral-border" aria-hidden="true" />
              <time
                dateTime={stats.recalculatedAt}
                title={new Date(stats.recalculatedAt).toLocaleString()}
              >
                Recalculated: {formatRelativeTime(stats.recalculatedAt)}
              </time>
            </>
          )}
          {/* Mobile MC signal now lives in MobileMonteCarloCard above StatusBar
              (issue #33); StatusBar itself is hidden md:block, so a md:hidden
              chip here was unreachable. */}
          {/* Online users — visible from lg (1024px), rule 45 */}
          <span className="hidden lg:flex items-center gap-1">
            <span className="w-px h-3 bg-neutral-border" aria-hidden="true" />
            <span
              className="w-1.5 h-1.5 bg-semantic-on-track rounded-full"
              aria-hidden="true"
            />
            {stats.onlineUsers} users online
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
