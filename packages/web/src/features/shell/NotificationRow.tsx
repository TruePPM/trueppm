/**
 * NotificationRow — single notification entry shown in both the slide-out
 * panel and the /me/notifications full-screen route (#311 phase 3).
 *
 * Click → navigate to source task; mark read on the way. Per-row [Mark read]
 * and [Archive] buttons keep the bulk actions discoverable. Inline [Snooze]
 * (presets) and [Mute notifications like this] surface the noise controls where
 * the noise is felt (ADR-0216, issue 1558) so a contributor never has to leave the
 * panel for the settings page to turn a noisy type down.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '@/components/Toast/toast';
import {
  type NotificationRow as NotificationRowType,
  type NotificationSnoozePreset,
  useMuteNotificationType,
  useSnoozeNotification,
  useUpdateNotification,
} from '@/hooks/useNotifications';
import { formatRelative } from '@/lib/formatRelative';

interface Props {
  notification: NotificationRowType;
  /** Called after the row navigates so the parent can close the slide-out panel. */
  onNavigate?: () => void;
}

const SNOOZE_PRESETS: { preset: NotificationSnoozePreset; label: string; toast: string }[] = [
  { preset: '1h', label: '1 hour', toast: 'Snoozed for 1 hour' },
  { preset: '3h', label: '3 hours', toast: 'Snoozed for 3 hours' },
  { preset: 'tomorrow', label: 'Tomorrow', toast: 'Snoozed until tomorrow' },
];

const actionBtn =
  'text-xs text-neutral-text-secondary hover:text-neutral-text-primary ' +
  'rounded-control px-2 h-7 ' +
  'focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none ' +
  'disabled:opacity-50';

export function NotificationRow({ notification, onNavigate }: Props) {
  const navigate = useNavigate();
  const update = useUpdateNotification();
  const snooze = useSnoozeNotification();
  const mute = useMuteNotificationType();
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  // An event-sourced row (#639/#497/#861) carries its own title/preview and has
  // no mention; a mention row renders from the mentioner + comment snippet.
  const isEvent = !!notification.event_type;
  const mentioner = notification.mention?.mentioner?.display_name ?? 'Someone';
  const isGroup = !!notification.mention?.mentioned_group_key;
  const groupKey = notification.mention?.mentioned_group_key;
  const title = isEvent
    ? notification.subject
    : `${mentioner} ${isGroup ? `mentioned @${groupKey}` : 'mentioned you'}`;
  const ts = formatRelative(new Date(notification.created_at));
  const preview = isEvent
    ? notification.body
    : notification.snippet || '(comment unavailable)';
  const ariaLabel = isEvent
    ? `${notification.subject}, ${ts}${notification.is_read ? '' : ', unread'}`
    : `Mention by ${mentioner}, ${ts}${notification.is_read ? '' : ', unread'}`;
  const isSnoozed = !!notification.snoozed_until;
  const busy = update.isPending || snooze.isPending || mute.isPending;

  function handleNavigate() {
    if (!notification.is_read) {
      update.mutate({ id: notification.id, is_read: true });
    }
    if (isEvent && notification.event_type === 'project.deleted') {
      // The project this row is about was just soft-deleted (issue 1115), so its
      // board/schedule routes 404 (the project queryset filters is_deleted=False).
      // Send the member to the app root instead — their remaining projects and the
      // Trash/restore surface live there — rather than a dead in-project link.
      void navigate('/');
    } else if (isEvent && notification.event_type.startsWith('signal.ceiling_proposal')) {
      // Ceiling-raise proposals (issue 1275) live in a settings section, not a task —
      // deep-link to it so the vote is one click from the inbox (the discovery
      // gap ADR-0104 Amendment B closes). Settings sections are anchors (web-rule 195).
      void navigate(`/projects/${notification.project}/settings#signal-privacy`);
    } else if (notification.task_id) {
      void navigate(`/projects/${notification.project}/schedule?task=${notification.task_id}`);
    } else {
      void navigate(`/projects/${notification.project}/board`);
    }
    onNavigate?.();
  }

  function handleMarkRead() {
    update.mutate({ id: notification.id, is_read: !notification.is_read });
  }

  function handleArchive() {
    update.mutate({ id: notification.id, is_archived: true });
  }

  function handleSnooze(preset: NotificationSnoozePreset, confirmation: string) {
    setSnoozeMenuOpen(false);
    snooze.mutate(
      { id: notification.id, preset },
      { onSuccess: () => toast.success(confirmation) },
    );
  }

  function handleUnsnooze() {
    snooze.mutate(
      { id: notification.id, until: null },
      { onSuccess: () => toast.info('Snooze cleared') },
    );
  }

  function handleMute() {
    const eventType = notification.event_type;
    mute.mutate(
      { eventType, mute: true },
      {
        onSuccess: () =>
          // In-app only (ADR-0216 §2) — email is untouched, hence "in your inbox".
          toast.action('Muted in your inbox', {
            label: 'Undo',
            ariaLabel: 'Undo mute',
            onClick: () => mute.mutate({ eventType, mute: false }),
          }),
      },
    );
  }

  return (
    <article
      aria-label={ariaLabel}
      className="flex flex-col gap-1 p-3 rounded-card border border-neutral-border bg-neutral-surface-raised"
    >
      <button
        type="button"
        onClick={handleNavigate}
        className="flex flex-col gap-1 text-left
          focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded-control"
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          {!notification.is_read && (
            <span
              aria-label="Unread"
              className="inline-block w-2 h-2 rounded-full bg-brand-primary flex-shrink-0"
            />
          )}
          <span className="text-sm font-medium text-neutral-text-primary">{title}</span>
          <span className="text-xs text-neutral-text-secondary tppm-mono ml-auto">{ts}</span>
        </div>
        <p className="text-xs text-neutral-text-secondary truncate">{preview}</p>
      </button>
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        <button type="button" onClick={handleMarkRead} disabled={busy} className={actionBtn}>
          {notification.is_read ? 'Mark unread' : 'Mark read'}
        </button>
        {!notification.is_archived && (
          <button type="button" onClick={handleArchive} disabled={busy} className={actionBtn}>
            Archive
          </button>
        )}
        {isSnoozed ? (
          <button type="button" onClick={handleUnsnooze} disabled={busy} className={actionBtn}>
            Un-snooze
          </button>
        ) : (
          <div className="relative">
            <button
              type="button"
              onClick={() => setSnoozeMenuOpen((open) => !open)}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={snoozeMenuOpen}
              className={actionBtn}
            >
              Snooze
            </button>
            {snoozeMenuOpen && (
              <div
                role="menu"
                aria-label="Snooze options"
                className="absolute left-0 top-full mt-1 z-10 flex flex-col
                  min-w-[8rem] rounded-card border border-neutral-border bg-neutral-surface p-1"
              >
                {SNOOZE_PRESETS.map((p) => (
                  <button
                    key={p.preset}
                    type="button"
                    role="menuitem"
                    onClick={() => handleSnooze(p.preset, p.toast)}
                    disabled={busy}
                    className="text-xs text-left text-neutral-text-secondary hover:text-neutral-text-primary
                      hover:bg-neutral-surface-raised rounded-control px-2 h-7
                      focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:outline-none
                      disabled:opacity-50"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Mute a *type* — mention rows omit it (you mute a type; a mention is a
            person addressing you). ADR-0216 §2. */}
        {isEvent && (
          <button type="button" onClick={handleMute} disabled={busy} className={actionBtn}>
            Mute notifications like this
          </button>
        )}
      </div>
    </article>
  );
}
