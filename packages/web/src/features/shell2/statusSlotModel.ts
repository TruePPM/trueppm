import type { SyncStatus } from '@/features/shell/syncStatus';

/**
 * Inputs the shell's single status slot resolves from. Every field is a fact
 * another surface already owns (the banners the v1 shell stacks); this module
 * only decides which ONE of them the slot shows.
 */
export interface StatusSlotInput {
  online: boolean;
  sessionExpired: boolean;
  sessionReadOnly: boolean;
  demoReadOnly: boolean;
  rateLimitDisabled: boolean;
  sync: SyncStatus;
}

type StatusSlotTone = 'quiet' | 'warn';

export interface StatusSlotModel {
  /** Stable identifier of the winning condition — the thing tests and the "+N" count key on. */
  kind:
    | 'offline'
    | 'session'
    | 'demo'
    | 'rate-limit'
    | 'sync-error'
    | 'sync-stale'
    | 'syncing'
    | 'synced';
  label: string;
  tone: StatusSlotTone;
  /** How many LOWER-priority conditions are also active and folded behind this one. */
  more: number;
  /** Labels of the folded conditions, for the slot's accessible description. */
  folded: string[];
}

interface Candidate {
  kind: StatusSlotModel['kind'];
  label: string;
  tone: StatusSlotTone;
}

/**
 * Resolve the one pill the shell shows. Priority is fixed and documented in the
 * shell spec: offline › session › demo › rate-limit, then the sync machine's own
 * error/stale/syncing, then a quiet "Synced". Lower-priority active conditions
 * are counted into `more` rather than stacked as banners.
 *
 * Why offline outranks an expired session: an offline client cannot re-auth
 * anyway, and the pending-write count is the fact the user can act on. Why
 * demo outranks rate-limit: demo read-only changes what every control does;
 * rate-limit is an operator notice that changes nothing for the person typing.
 */
export function resolveStatusSlot(input: StatusSlotInput): StatusSlotModel {
  const active: Candidate[] = [];

  if (!input.online) {
    const pending = input.sync.kind === 'offline' ? input.sync.pending : 0;
    active.push({
      kind: 'offline',
      label:
        pending > 0
          ? `Offline · ${pending} ${pending === 1 ? 'change' : 'changes'} pending`
          : 'Offline',
      tone: 'warn',
    });
  }
  if (input.sessionExpired) {
    active.push({
      kind: 'session',
      label: input.sessionReadOnly ? 'Session expired · read-only' : 'Session expired',
      tone: 'warn',
    });
  }
  if (input.demoReadOnly) {
    active.push({ kind: 'demo', label: 'Demo · read-only', tone: 'warn' });
  }
  if (input.rateLimitDisabled) {
    active.push({ kind: 'rate-limit', label: 'Rate limiting off', tone: 'warn' });
  }
  // The sync machine already folds offline into its own `offline` kind; that
  // case is carried by the `offline` candidate above, so only the states that
  // add information past connectivity are candidates here.
  if (input.online) {
    if (input.sync.kind === 'error') {
      const n = input.sync.errorCount;
      active.push({
        kind: 'sync-error',
        label: `${n} ${n === 1 ? 'write' : 'writes'} failed`,
        tone: 'warn',
      });
    } else if (input.sync.kind === 'stale') {
      active.push({ kind: 'sync-stale', label: 'Live updates paused', tone: 'warn' });
    } else if (input.sync.kind === 'syncing') {
      active.push({ kind: 'syncing', label: `Syncing ${input.sync.count}…`, tone: 'quiet' });
    }
  }

  if (active.length === 0) {
    return { kind: 'synced', label: 'Synced', tone: 'quiet', more: 0, folded: [] };
  }
  const [head, ...rest] = active;
  return {
    kind: head.kind,
    label: head.label,
    tone: head.tone,
    more: rest.length,
    folded: rest.map((c) => c.label),
  };
}
