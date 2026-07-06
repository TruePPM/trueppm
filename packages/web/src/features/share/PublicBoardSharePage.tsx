import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  classifyShareError,
  fetchPublicBoard,
  type PublicBoard,
  type PublicBoardCard,
  type PublicBoardErrorKind,
} from './shareApi';

/**
 * Public, unauthenticated, read-only board viewer (#283, ADR-0245). Standalone —
 * NOT inside the app shell (no sidebar/topbar/auth). Fetches via bare axios so it
 * never touches the authenticated apiClient. Every card is a non-interactive node:
 * no drag, no popover, no create affordance anywhere.
 */

function StatePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-surface px-4">
      <div className="w-full max-w-sm rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
        <h1 className="mb-1 text-sm font-semibold text-neutral-text-primary">{title}</h1>
        <p className="text-xs text-neutral-text-secondary">{body}</p>
      </div>
      {/* Brand mark on every state (incl. error/revoked) so an external viewer can
          tell this is a legitimate TruePPM page, matching the AuthShell precedent. */}
      <p className="mt-4 text-xs font-medium text-neutral-text-disabled">TruePPM</p>
    </div>
  );
}

function Card({ card }: { card: PublicBoardCard }) {
  const pct = Math.max(0, Math.min(100, Math.round(card.percent_complete)));
  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface p-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="tppm-mono text-xs text-neutral-text-secondary">{card.short_id}</span>
        {card.is_milestone ? (
          <span className="rounded-chip bg-brand-accent-light px-1 text-xs font-medium text-brand-primary">
            Milestone
          </span>
        ) : null}
      </div>
      <div className="text-[12px] leading-snug text-neutral-text-primary">{card.name}</div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-surface-sunken">
        <div
          className="h-full rounded-full bg-brand-primary"
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-neutral-text-secondary">
        <span>{pct}%</span>
        {card.due_date ? <span>Due {card.due_date}</span> : null}
      </div>
      {card.assignee ? (
        <div className="mt-1 text-xs text-neutral-text-secondary">👤 {card.assignee}</div>
      ) : null}
    </div>
  );
}

function Board({ board }: { board: PublicBoard }) {
  const totalCards = board.columns.reduce((sum, c) => sum + c.cards.length, 0);
  return (
    <div className="min-h-screen bg-neutral-surface">
      <header className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-neutral-text-primary">
              {board.project.name || 'Board'}
            </h1>
            {board.project.short_id ? (
              <span className="text-xs text-neutral-text-secondary">
                {board.project.short_id}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-chip border border-neutral-border bg-neutral-surface px-2 py-0.5 text-xs font-medium text-neutral-text-secondary">
            Read-only shared view
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {totalCards === 0 ? (
          <div className="rounded-card border border-dashed border-neutral-border p-10 text-center">
            <p className="text-[12px] text-neutral-text-secondary">No cards to show yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-4 sm:overflow-x-auto sm:pb-2">
            {board.columns.map((col) => (
              <section key={col.key} className="sm:w-72 sm:shrink-0">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-[12px] font-semibold text-neutral-text-primary">{col.label}</h2>
                  <span className="text-xs text-neutral-text-secondary">{col.cards.length}</span>
                </div>
                <div className="space-y-2">
                  {col.cards.map((card) => (
                    <Card key={card.short_id} card={card} />
                  ))}
                  {col.cards.length === 0 ? (
                    <p className="rounded-card border border-dashed border-neutral-border p-3 text-center text-xs text-neutral-text-secondary">
                      Empty
                    </p>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
        {board.truncated ? (
          <p className="mt-4 text-center text-xs text-neutral-text-secondary">
            Showing the first 1,000 cards.
          </p>
        ) : null}
      </main>

      <footer className="py-6 text-center text-xs text-neutral-text-disabled">
        Shared via TruePPM
      </footer>
    </div>
  );
}

export function PublicBoardSharePage() {
  const { token } = useParams<{ token: string }>();
  const [board, setBoard] = useState<PublicBoard | null>(null);
  const [error, setError] = useState<PublicBoardErrorKind | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchPublicBoard(token ?? '')
      .then((data) => {
        if (active) setBoard(data);
      })
      .catch((err: unknown) => {
        if (active) setError(classifyShareError(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (loading) {
    return <StatePage title="Loading…" body="Fetching the shared board." />;
  }
  if (error === 'revoked') {
    return (
      <StatePage
        title="This link has been revoked"
        body="Ask the project owner for a new share link."
      />
    );
  }
  if (error || !board) {
    return (
      <StatePage
        title="This share link isn't available"
        body="The link may be invalid, or sharing may be turned off for this project."
      />
    );
  }
  return <Board board={board} />;
}
