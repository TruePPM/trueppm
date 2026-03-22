import { useShellStats } from '@/hooks/useShellStats';

function formatLastSaved(iso: string | null): string {
  if (!iso) return '—';
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'Saved just now';
  if (diff < 3600) return `Saved ${Math.floor(diff / 60)}m ago`;
  return `Saved ${new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

const LEGEND = [
  { label: 'On track', color: '#166534' },
  { label: 'At risk', color: '#92400E' },
  { label: 'Critical', color: '#B91C1C' },
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
          <span aria-label={`${stats.criticalPathCount} on critical path`}>
            · {stats.criticalPathCount} critical path
          </span>
          <time
            dateTime={stats.lastSaved ?? ''}
            title={stats.lastSaved ? new Date(stats.lastSaved).toLocaleString() : undefined}
          >
            · {formatLastSaved(stats.lastSaved)}
          </time>
          <span className="hidden 2xl:block">· {stats.onlineUsers} online</span>
        </>
      ) : (
        <span aria-live="polite">Loading…</span>
      )}

      {/* Color legend — right-aligned, hidden below md */}
      <span className="hidden md:flex ml-auto items-center gap-3" aria-label="Health legend">
        {LEGEND.map(({ label, color }) => (
          <span key={label} className="flex items-center gap-1">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            <span>{label}</span>
          </span>
        ))}
      </span>
    </footer>
  );
}
