import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useMyWork } from '@/hooks/useMyWork';
import { useCreateTimeEntry } from '@/hooks/useCreateTimeEntry';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { toast } from '@/components/Toast';
import { localTodayIso } from '@/lib/localDate';
import {
  buildEntries,
  formatHours,
  spokenHours,
  stepHours,
  totalHours,
  type HoursByTask,
} from './quickLogModel';

const STEP_BTN =
  'flex h-11 w-11 items-center justify-center rounded-full border border-p1-hairline text-lg text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus aria-disabled:opacity-40';

export interface QuickLogSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The phone bottom bar's quick-log sheet (shell v2, Pass 1 `phoneLog`): the
 * viewer's tasks due today, one half-hour stepper each, one Save.
 *
 * "Due today" is the server's `group === 'today'` My Work bucket, not a client
 * date comparison. Writes go through `useCreateTimeEntry` (the same endpoint and
 * Undo toast as every other capture surface). Offline, TanStack pauses those
 * mutations and they replay on reconnect, so Save does not wait on them: it
 * hands them to the queue and closes. Online, Save waits so a refused entry can
 * stay on screen with its reason in a sibling `role="alert"` (rule 372).
 */
export function QuickLogSheet({ isOpen, onClose }: QuickLogSheetProps) {
  const headingId = useId();
  const online = useOnlineStatus();
  const { data, isError } = useMyWork();
  const create = useCreateTimeEntry({ toastErrors: false });
  const [hours, setHours] = useState<HoursByTask>({});
  const [announcement, setAnnouncement] = useState('');
  const [refused, setRefused] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Mounted on every phone route, so tolerate an unexpected payload (`p?.results`).
  const tasks = useMemo(
    () =>
      (data?.pages ?? [])
        .flatMap((p) => p?.results ?? [])
        .filter((t) => t.group === 'today' && !t.is_phase),
    [data],
  );
  const taskIds = tasks.map((t) => t.id);
  const entries = buildEntries(taskIds, hours);
  const total = totalHours(hours);

  function step(taskId: string, name: string, direction: 1 | -1) {
    const current = hours[taskId] ?? 0;
    const next = stepHours(current, direction);
    if (next === current) return;
    setHours((h) => ({ ...h, [taskId]: next }));
    // One discrete announcement per press — the changed task's value, not a running total.
    setAnnouncement(`${name}: ${spokenHours(next)}`);
    setRefused([]);
  }

  function close() {
    setHours({});
    setAnnouncement('');
    setRefused([]);
    onClose();
  }

  async function save() {
    if (entries.length === 0 || saving) return;
    const nameOf = (id: string) => tasks.find((t) => t.id === id)?.name ?? 'a task';
    const labelOf = (id: string) => nameOf(id);
    const entryDate = localTodayIso();
    const send = (e: (typeof entries)[number]) =>
      create.mutateAsync({
        taskId: e.taskId,
        taskLabel: labelOf(e.taskId),
        minutes: e.minutes,
        entryDate,
      });
    if (!online) {
      // Paused by TanStack until the browser is back online; never awaited.
      entries.forEach((e) => void send(e).catch(() => undefined));
      toast.info(`Saved ${formatHours(total)} — will send when online.`);
      close();
      return;
    }
    setSaving(true);
    const results = await Promise.allSettled(entries.map(send));
    setSaving(false);
    const failed = entries.filter((_, i) => results[i].status === 'rejected');
    if (failed.length === 0) {
      close();
      return;
    }
    // Keep only the refused rows' values so Save retries just those.
    setHours(Object.fromEntries(failed.map((e) => [e.taskId, e.minutes / 60])));
    setRefused(failed.map((e) => nameOf(e.taskId)));
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={close}
      titleId={headingId}
      size="large"
      mobileOnly={false}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        <h2 id={headingId} className="text-base font-semibold text-p1-text-1">
          Log time
        </h2>
        <p className="-mt-2 text-xs text-p1-text-2">Tasks due today</p>

        {isError ? (
          <p className="text-sm text-p1-text-2">
            Could not load today&apos;s tasks.{' '}
            <Link to="/me/timesheet" onClick={close} className="underline">
              Open the timesheet
            </Link>
          </p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-p1-text-2" data-testid="quicklog-empty">
            Nothing is due today.{' '}
            <Link to="/me/timesheet" onClick={close} className="font-medium underline">
              Log time on the timesheet
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-p1-hairline">
            {tasks.map((t) => {
              const value = hours[t.id] ?? 0;
              return (
                <li key={t.id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-p1-text-1">{t.name}</div>
                    <div className="truncate text-xs text-p1-text-2">{t.project_name}</div>
                  </div>
                  <div
                    role="group"
                    aria-label={`Hours on ${t.name}`}
                    className="flex items-center gap-1"
                  >
                    <button
                      type="button"
                      aria-label={`Decrease hours on ${t.name}`}
                      aria-disabled={value <= 0}
                      onClick={() => step(t.id, t.name, -1)}
                      className={STEP_BTN}
                    >
                      <span aria-hidden="true">−</span>
                    </button>
                    <span
                      className="w-12 text-center font-mono text-sm text-p1-text-1"
                      data-testid={`quicklog-value-${t.id}`}
                    >
                      {formatHours(value)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Increase hours on ${t.name}`}
                      onClick={() => step(t.id, t.name, 1)}
                      className={STEP_BTN}
                    >
                      <span aria-hidden="true">+</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Transition announcements and the refusal live in SIBLING regions (rule 372). */}
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {refused.length > 0 && (
          <p role="alert" className="text-sm text-p1-critical">
            Could not log time on {refused.join(', ')}. Check the entries and try again.
          </p>
        )}
        {!online && (
          <p className="text-xs text-p1-text-2" data-testid="quicklog-offline">
            You are offline — entries will send when online.
          </p>
        )}

        <div className="flex flex-col gap-2 pt-1">
          {tasks.length > 0 && (
            <button
              type="button"
              onClick={() => void save()}
              aria-disabled={entries.length === 0 || saving}
              className="h-11 w-full rounded-md bg-p1-brand text-sm font-medium text-p1-on-brand focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-offset-2 aria-disabled:opacity-50"
            >
              {saving ? 'Saving…' : entries.length > 0 ? `Save ${formatHours(total)}` : 'Save'}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="h-11 w-full rounded-md border border-p1-hairline text-sm text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus"
          >
            Dismiss
          </button>
          {tasks.length > 0 && (
            <Link
              to="/me/timesheet"
              onClick={close}
              className="flex h-11 items-center justify-center text-sm text-p1-text-2 underline"
            >
              Open full timesheet
            </Link>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
