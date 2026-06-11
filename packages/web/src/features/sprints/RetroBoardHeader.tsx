import { RetroVisibilityToggle } from './RetroVisibilityToggle';
import { RetroPresenceChips } from './RetroPresenceChips';
import type { RetroVisibility } from '@/hooks/useSprints';

interface Props {
  /** Current retro visibility — null while no retro row exists yet. */
  visibility: RetroVisibility | null;
  canEditVisibility: boolean;
  visibilityPending: boolean;
  onChangeVisibility: (next: RetroVisibility) => void;
  /** True when the live board's WebSocket connection has dropped. */
  offline: boolean;
}

/**
 * Header for the live retro board (ADR-0117 §6): title, presence chips, the
 * existing visibility toggle, and an offline banner when the realtime channel
 * is down (writes still work via REST; peers just won't see them live until
 * reconnect, which reconciles via the sync delta).
 */
export function RetroBoardHeader({
  visibility,
  canEditVisibility,
  visibilityPending,
  onChangeVisibility,
  offline,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2
            id="retro-panel-heading"
            className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
          >
            Retrospective
          </h2>
          <RetroPresenceChips />
        </div>
        {canEditVisibility && visibility && (
          <RetroVisibilityToggle
            value={visibility}
            disabled={visibilityPending}
            onChange={onChangeVisibility}
          />
        )}
      </div>

      {offline && (
        <p
          role="status"
          className="text-xs text-semantic-warning bg-semantic-warning-bg rounded px-2 py-1"
        >
          You&apos;re offline — your cards still save and will sync when the connection returns.
        </p>
      )}
    </div>
  );
}
