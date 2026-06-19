/**
 * WorkshopBanner — sticky banner shown above the board during workshop mode.
 *
 * Shows the elapsed session timer, participant count, and an "End Workshop"
 * button. The elapsed timer updates every second via setInterval.
 */
import { useEffect, useState } from 'react';
import type { WorkshopSession } from '@/types';

interface WorkshopBannerProps {
  session: WorkshopSession;
  onEnd: () => void;
  isEnding?: boolean;
}

function formatElapsed(startedAt: string): string {
  const diffMs = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function WorkshopBanner({ session, onEnd, isEnding = false }: WorkshopBannerProps) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(session.started_at));

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(formatElapsed(session.started_at));
    }, 1000);
    return () => clearInterval(id);
  }, [session.started_at]);

  const activeParticipants = session.participants.filter((p) => p.left_at === null);
  const participantCount = activeParticipants.length;

  return (
    <div
      role="status"
      aria-label="Workshop session active"
      aria-live="polite"
      className="flex-shrink-0 flex items-center gap-3 px-4 py-2
        bg-brand-primary/10 border-b border-brand-primary/30 text-xs"
    >
      {/* Indicator dot */}
      <span
        aria-hidden="true"
        className="w-2 h-2 rounded-full bg-brand-primary animate-pulse flex-shrink-0"
      />

      {/* Session label */}
      <span className="font-semibold text-brand-primary-dark dark:text-brand-primary">
        Workshop mode
      </span>

      {/* Elapsed timer */}
      <span
        className="tppm-mono text-neutral-text-secondary"
        aria-label={`Session elapsed time: ${elapsed}`}
      >
        {elapsed}
      </span>

      {/* Participant count */}
      {participantCount > 0 && (
        <span
          className="text-neutral-text-secondary"
          aria-label={`${participantCount} participant${participantCount !== 1 ? 's' : ''} online`}
        >
          {participantCount} online
        </span>
      )}

      {/* Participant avatar strip (up to 5) */}
      <div className="flex -space-x-1" aria-hidden="true">
        {activeParticipants.slice(0, 5).map((p) => (
          <span
            key={p.id}
            className="w-5 h-5 rounded-full border border-neutral-surface flex items-center justify-center text-xs font-semibold text-white"
            style={{ backgroundColor: `var(--avatar-color-${p.color_index % 8})` }}
            title={p.display_name}
          >
            {p.display_name.charAt(0).toUpperCase()}
          </span>
        ))}
        {activeParticipants.length > 5 && (
          <span
            className="w-5 h-5 rounded-full border border-neutral-surface bg-neutral-border
              flex items-center justify-center text-xs font-semibold text-neutral-text-secondary"
          >
            +{activeParticipants.length - 5}
          </span>
        )}
      </div>

      <div className="ml-auto">
        <button
          type="button"
          onClick={onEnd}
          disabled={isEnding}
          className="border border-brand-primary/40 rounded-control px-3 py-1
            text-brand-primary-dark dark:text-brand-primary font-medium
            hover:bg-brand-primary/10 disabled:opacity-50
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          aria-label="End workshop session"
        >
          {isEnding ? 'Ending…' : 'End Workshop'}
        </button>
      </div>
    </div>
  );
}

// Avatar palette is defined in globals.css as --avatar-color-{0..7}.
// Index assigned by WorkshopConsumer: int(user_pk_hex, 16) % 8.
