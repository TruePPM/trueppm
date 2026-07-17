import { useEffect, useRef, useState } from 'react';
import { usePresenceStore, type PresenceUser } from '@/stores/presenceStore';

const MAX_VISIBLE = 5;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * "Who's in the retro" presence chips (ADR-0117 §4).
 *
 * Reads the project presence store (the retro reuses the existing
 * ProjectConsumer presence hash). Renders up to five initial avatars plus a
 * "+N" overflow; the whole group carries an aria-label listing every present
 * name so a screen reader hears the full roster, not just the truncated chips.
 *
 * The "+N" chip is a button that opens a small popover enumerating the
 * overflowed participants (avatar + display name) so the truncated names are
 * reachable by sighted and keyboard users alike. The popover closes on Escape
 * and outside-click, returning focus to the trigger.
 */
export function RetroPresenceChips() {
  const usersById = usePresenceStore((s) => s.users);
  const users: PresenceUser[] = Object.values(usersById).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on Escape + outside-click; restore focus to the trigger on close so
  // a keyboard user is never stranded.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflowUsers = users.slice(MAX_VISIBLE);
  const overflow = overflowUsers.length;
  const names = users.map((u) => u.display_name).join(', ');

  return (
    <div
      className="relative flex items-center -space-x-1"
      aria-label={`In this retro: ${names}`}
    >
      {visible.map((u) => (
        <span
          key={u.user_id}
          title={u.display_name}
          aria-hidden="true"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full
            border border-neutral-surface bg-brand-primary text-neutral-text-inverse text-xs font-semibold tppm-mono"
        >
          {initials(u.display_name)}
        </span>
      ))}
      {overflow > 0 && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Show ${overflow} more participant${overflow === 1 ? '' : 's'}`}
            className="relative inline-flex h-11 min-w-11 items-center justify-center
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              rounded-full"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-6 min-w-6 items-center justify-center rounded-full
                border border-neutral-surface bg-neutral-surface-sunken px-1 text-xs font-semibold tppm-mono text-neutral-text-secondary"
            >
              +{overflow}
            </span>
          </button>
          {open && (
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="More retro participants"
              className="absolute left-0 top-full z-30 mt-2 w-56 rounded-card border border-neutral-border
                bg-neutral-surface text-neutral-text-primary text-xs shadow-pop"
            >
              <ul className="flex flex-col gap-1.5 p-2">
                {overflowUsers.map((u) => (
                  <li key={u.user_id} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                        bg-brand-primary text-neutral-text-inverse text-xs font-semibold tppm-mono"
                    >
                      {initials(u.display_name)}
                    </span>
                    <span className="truncate">{u.display_name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
