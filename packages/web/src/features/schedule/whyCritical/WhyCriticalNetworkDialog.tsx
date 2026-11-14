import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { ScheduleDrivingChain } from '@/api/types';
import {
  BAND_TEXT,
  bandWord,
  floatLabel,
  formatUtcStamp,
  type ChainCard,
  type WhyCriticalView,
} from './whyCriticalModel';

interface Props {
  chain: ScheduleDrivingChain;
  view: WhyCriticalView;
  copyText: string;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * Desktop-only (≥ 768 px) upstream network view of the driving chain (#4892).
 *
 * Columns are the payload's `hops` (this task at the right, upstream to the
 * left); inside a column, driving cards come first, then payload order. There
 * is no layout heuristic on graph structure. The diagram is one tab stop with
 * a roving focus; edges are hidden from AT and their meaning lives in each
 * node's description, and the vertical list in the drawer remains the full
 * form at every width.
 */
export function WhyCriticalNetworkDialog({ chain, view, copyText, onClose, onOpenTask }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  // Escape closes this dialog only. The drawer underneath also listens for
  // Escape on `document` and registered first, so a bubbling listener (the
  // focus trap's) would close the drawer too; a window capture listener runs
  // before either and stops the event there.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const hopsById = useMemo(() => new Map(chain.nodes.map((n) => [n.task_id, n.hops])), [chain]);
  const columns = useMemo(() => {
    const cards = view.cards.filter((c) => c.kind !== 'finish');
    const byHops = new Map<number, ChainCard[]>();
    for (const c of cards) {
      const h = Math.min(...c.memberIds.map((id) => hopsById.get(id) ?? 0));
      const list = byHops.get(h) ?? [];
      list.push(c);
      byHops.set(h, list);
    }
    return [...byHops.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([hops, list]) => ({
        hops,
        cards: [...list.filter((c) => !c.nonDriving), ...list.filter((c) => c.nonDriving)],
      }));
  }, [view, hopsById]);
  const selfKey = view.cards.find((c) => c.kind === 'self')?.key ?? '';
  const [focused, setFocused] = useState(selfKey);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const nameOf = (c: ChainCard) => (c.kind === 'self' ? view.self.name : c.title);

  const locate = (key: string) => {
    for (let ci = 0; ci < columns.length; ci++) {
      const ri = columns[ci].cards.findIndex((c) => c.key === key);
      if (ri >= 0) return { ci, ri };
    }
    return { ci: columns.length - 1, ri: 0 };
  };

  const move = (key: string | undefined) => {
    if (!key) return;
    setFocused(key);
    refs.current[key]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, card: ChainCard) => {
    const { ci, ri } = locate(card.key);
    const col = columns[ci];
    switch (e.key) {
      case 'ArrowLeft':
        move(columns[ci - 1]?.cards[0]?.key);
        break;
      case 'ArrowRight':
        move(columns[ci + 1]?.cards[0]?.key);
        break;
      case 'ArrowUp':
        move(col.cards[ri - 1]?.key);
        break;
      case 'ArrowDown':
        move(col.cards[ri + 1]?.key);
        break;
      case 'Home':
        move(selfKey);
        break;
      case 'End':
        move(columns[0]?.cards[0]?.key);
        break;
      case 'Enter':
      case ' ':
        if (card.taskId && card.kind !== 'self' && onOpenTask) onOpenTask(card.taskId);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const focusedCard = view.cards.find((c) => c.key === focused);
  const describe = (c: ChainCard) =>
    c.outEdges.length === 0
      ? 'This task.'
      : c.outEdges
          .map((e) =>
            e.driving
              ? `Drives: ${e.label}.`
              : `Linked, not driving: ${e.label.replace('Not driving · ', '')}.`,
          )
          .join(' ');
  const finish = view.cards.find((c) => c.kind === 'finish');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="why-critical-network-title"
        className="w-[min(1000px,calc(100vw-2rem))] max-h-[min(680px,calc(100vh-2rem))] overflow-auto rounded-card bg-neutral-surface p-5 shadow-pop"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="why-critical-network-title"
              className="text-lg font-semibold text-neutral-text-primary"
            >
              Why {view.self.name} is critical
            </h2>
            <p className="text-xs text-neutral-text-secondary">
              Upstream only · {chain.edges.length} of {chain.total_links} links shown · Schedule
              computed {formatUtcStamp(chain._provenance.computed_at)}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                navigator.clipboard
                  .writeText(copyText)
                  .then(() => setCopied('copied'))
                  .catch(() => setCopied('failed'));
              }}
            >
              {copied === 'copied' ? (
                <>
                  <span aria-hidden="true">✓ </span>Copied
                </>
              ) : (
                'Copy as text'
              )}
            </Button>
            <Button variant="ghost" size="sm" aria-label="Close network view" onClick={onClose}>
              ×
            </Button>
          </div>
        </div>
        <p role="status" className="sr-only">
          {copied === 'copied' ? 'Copied to clipboard as plain text.' : ''}
        </p>
        {copied === 'failed' && (
          <div className="mt-3 space-y-1">
            <p className="text-sm text-neutral-text-secondary">
              {"Couldn't copy. Select the text below and copy it."}
            </p>
            <label className="sr-only" htmlFor="why-critical-network-copy-fallback">
              Why critical as text
            </label>
            <textarea
              id="why-critical-network-copy-fallback"
              readOnly
              value={copyText}
              rows={6}
              ref={(el) => el?.select()}
              className="w-full tppm-mono text-xs rounded-control border border-neutral-border p-2"
            />
          </div>
        )}
        <div
          role="group"
          aria-label="Driving chain diagram. Use arrow keys to move between tasks."
          className="mt-4 flex gap-6 overflow-x-auto"
        >
          {columns.map((col) => (
            <div key={col.hops} className="flex min-w-[180px] flex-col gap-3">
              <p className="text-xs font-semibold text-neutral-text-secondary">
                {col.hops === 0
                  ? 'This task'
                  : `${col.hops} ${col.hops === 1 ? 'step' : 'steps'} back`}
              </p>
              {col.cards.map((card) => {
                const word = bandWord(card.band);
                const label = `${nameOf(card)}. ${card.subtitle}. ${card.float} working ${
                  card.float === 1 ? 'day' : 'days'
                } float.${word ? ` ${word}.` : ''}`;
                return (
                  <button
                    key={card.key}
                    ref={(el) => {
                      refs.current[card.key] = el;
                    }}
                    type="button"
                    tabIndex={card.key === focused ? 0 : -1}
                    aria-label={label}
                    aria-describedby="why-critical-network-focus"
                    onFocus={() => setFocused(card.key)}
                    onKeyDown={(e) => onKeyDown(e, card)}
                    onClick={() => card.taskId && card.kind !== 'self' && onOpenTask?.(card.taskId)}
                    className={[
                      'rounded-control px-3 py-2 text-left bg-neutral-surface',
                      card.kind === 'self'
                        ? 'border-[2.5px] border-neutral-text-primary'
                        : 'border border-neutral-border',
                      card.nonDriving ? 'border-dashed' : '',
                      card.band === 'near_critical' ? 'border-semantic-at-risk' : '',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-semibold text-neutral-text-primary">
                      {nameOf(card)}
                    </span>
                    <span className="block text-xs text-neutral-text-secondary">
                      {card.subtitle}
                    </span>
                    <span className="block text-xs">
                      <span className="tppm-mono">{floatLabel(card.float)}</span>
                      {word && (
                        <span className={`font-semibold ${BAND_TEXT[card.band]}`}> · {word}</span>
                      )}
                    </span>
                    {card.nonDriving && (
                      <span
                        aria-hidden="true"
                        className="block text-xs text-neutral-text-secondary"
                      >
                        Not driving
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p
          id="why-critical-network-focus"
          aria-live="off"
          className="mt-4 rounded-control bg-neutral-surface-sunken px-3 py-2 text-sm text-neutral-text-primary"
        >
          {focusedCard
            ? `${nameOf(focusedCard)} · ${focusedCard.subtitle}. ${describe(focusedCard)}`
            : ''}
        </p>
        <p className="mt-3 text-xs text-neutral-text-secondary">
          Solid link: driving, critical or near-critical · Dashed: Not driving ·{' '}
          {view.thresholdLine} · {view.unitsLine}
          {finish
            ? ` · Project finish: ${finish.subtitle.split(' · ')[0].replace('Finishes ', '')} (not drawn, downstream)`
            : ''}
        </p>
      </div>
    </div>,
    document.body,
  );
}
