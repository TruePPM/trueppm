/**
 * NotesSection — task drawer why/decision log (ADR-0143, issue 740).
 *
 * Distinct from {@link CommentSection} (threaded discussion): notes are flat,
 * pinned-first, immutable rows. The author may edit their own note's body within
 * a 15-minute window (server-enforced); any MEMBER+ may pin; the author or an
 * ADMIN may delete. A card-scoped client-side dim-search filters the already-
 * fetched list — matches stay full opacity, non-matches dim to 0.3 (they remain
 * visible and readable) with a live "N of M" counter.
 *
 * The `decision` flag (ADR-0167, issue 748) is surfaced as a one-tap chip alongside pin:
 * any MEMBER+ may flag a note as a decision, promoting it into the project/sprint
 * Decisions views. Read-only viewers see a static "Decision" badge when flagged.
 */

import type { ReactElement } from 'react';
import { PinIcon } from '@/components/Icons';
import { useState } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { canEditTask, ROLE_ADMIN } from '@/lib/roles';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  useDeleteNote,
  usePinNote,
  useTaskNotes,
  useToggleDecision,
  useUpdateNote,
} from '@/hooks/useTaskNotes';
import { useNotesSearch } from '@/hooks/useNotesSearch';
import { formatRelative } from '@/lib/formatRelative';
import type { TaskNote } from '@/types';
import { NotesComposer } from './NotesComposer';

/** ADR-0143 — the author's self-edit window (mirrors NOTE_EDIT_WINDOW_SECONDS). */
const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Mirrors the composer/server cap so inline edits stay in bounds. */
const MAX_BODY_CHARS = 10_000;

/** Case-insensitive substring highlight, escaping the body via React text nodes. */
function highlight(text: string, query: string): ReactElement[] {
  const q = query.trim();
  if (!q) return [<span key="all">{text}</span>];
  const out: ReactElement[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0;
  let i = lower.indexOf(needle, from);
  let k = 0;
  while (i !== -1) {
    if (i > from) out.push(<span key={`t-${k}`}>{text.slice(from, i)}</span>);
    out.push(
      <mark
        key={`m-${k}`}
        className="bg-brand-primary/20 text-neutral-text-primary rounded-chip px-0.5"
      >
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    from = i + needle.length;
    i = lower.indexOf(needle, from);
    k++;
  }
  if (from < text.length) out.push(<span key="tail">{text.slice(from)}</span>);
  return out;
}

interface NoteRowProps {
  note: TaskNote;
  projectId: string;
  taskId: string;
  /** Viewer may pin (any MEMBER+). */
  editable: boolean;
  /** Viewer may delete this note (author or ADMIN+). */
  canDelete: boolean;
  /** Viewer may still edit this note (own note, within the 15-min window). */
  canEditBody: boolean;
  /** Current search query for body highlighting; '' when not searching. */
  query: string;
  /** Whether this row matches the active search (full opacity vs dimmed). */
  matches: boolean;
}

function NoteRow({
  note,
  projectId,
  taskId,
  editable,
  canDelete,
  canEditBody,
  query,
  matches,
}: NoteRowProps) {
  const pin = usePinNote();
  const decision = useToggleDecision();
  const del = useDeleteNote();
  const update = useUpdateNote();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);

  const author = note.author?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(note.created_at));
  const wasEdited = note.edited_at != null;

  function handleSaveEdit() {
    const body = draft.trim();
    if (!body || body.length > MAX_BODY_CHARS) return;
    update.mutate(
      { projectId, taskId, noteId: note.id, body },
      { onSuccess: () => setIsEditing(false) },
    );
  }

  return (
    <li
      className={`flex flex-col gap-1 p-3 rounded-card border bg-neutral-surface-raised transition-opacity ${
        note.pinned ? 'border-brand-primary/40' : 'border-neutral-border'
      } ${matches ? 'opacity-100' : 'opacity-30'}`}
      aria-label={`Note by ${author}, ${ts}${note.pinned ? ', pinned' : ''}${
        note.decision ? ', decision' : ''
      }${wasEdited ? ', edited' : ''}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        {note.pinned && (
          <span className="text-brand-primary" title="Pinned" aria-hidden="true">
            <PinIcon className="inline-block h-3 w-3 align-[-0.125em]" />
          </span>
        )}
        {note.decision && (
          <span
            className="rounded-chip bg-brand-primary/10 px-1.5 py-0.5 text-xs font-medium text-brand-primary"
            title="Decision"
          >
            <span aria-hidden="true">⚖</span> Decision
          </span>
        )}
        <span className="text-sm font-medium text-neutral-text-primary">{author}</span>
        <span className="text-xs text-neutral-text-secondary tppm-mono">{ts}</span>
        {wasEdited && <span className="text-xs text-neutral-text-secondary italic">· edited</span>}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`note-edit-${note.id}`}>
            Edit note
          </label>
          <textarea
            id={`note-edit-${note.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={MAX_BODY_CHARS}
            className="text-sm bg-neutral-surface border border-neutral-border rounded-control p-2
              text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              resize-y min-h-[60px]"
          />
          {update.isError && (
            <span className="text-xs text-semantic-critical" role="alert">
              Couldn&apos;t save — the 15-minute edit window may have closed.
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={update.isPending || draft.trim().length === 0}
              className="text-xs border border-brand-primary/40 text-brand-primary rounded-control px-3 h-7 font-medium
                hover:bg-brand-primary/10
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                disabled:opacity-50"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(note.body);
                setIsEditing(false);
              }}
              disabled={update.isPending}
              className="text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-neutral-text-primary whitespace-pre-wrap break-words">
          {highlight(note.body, query)}
        </div>
      )}

      {/* Write affordances — hidden entirely for read-only viewers. */}
      {editable && !isEditing && (
        <div className="flex items-center gap-1 mt-1">
          <button
            type="button"
            onClick={() => pin.mutate({ projectId, taskId, noteId: note.id })}
            disabled={pin.isPending}
            aria-pressed={note.pinned}
            aria-label={note.pinned ? 'Unpin this note' : 'Pin this note'}
            className={`text-xs border rounded-control px-2 h-7 font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50
              ${
                note.pinned
                  ? 'border-brand-primary/40 text-brand-primary bg-brand-primary/10'
                  : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface'
              }`}
          >
            <PinIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
            {note.pinned ? 'Pinned' : 'Pin'}
          </button>
          <button
            type="button"
            onClick={() => decision.mutate({ projectId, taskId, noteId: note.id })}
            disabled={decision.isPending}
            aria-pressed={note.decision}
            aria-label={note.decision ? 'Unmark as decision' : 'Mark as decision'}
            className={`text-xs border rounded-control px-2 h-7 font-medium
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50
              ${
                note.decision
                  ? 'border-brand-primary/40 text-brand-primary bg-brand-primary/10'
                  : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface'
              }`}
          >
            ⚖ Decision
          </button>
          {canEditBody && (
            <button
              type="button"
              onClick={() => {
                setDraft(note.body);
                setIsEditing(true);
              }}
              className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              aria-label="Edit this note"
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => del.mutate({ projectId, taskId, noteId: note.id })}
              disabled={del.isPending}
              className="text-xs border border-neutral-border rounded-control px-2 h-7 font-medium
                text-neutral-text-secondary hover:bg-semantic-critical-bg hover:text-semantic-critical hover:border-semantic-critical/40
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                disabled:opacity-50"
              aria-label="Delete this note"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function NotesSection({ taskId, projectId, userRole, canEdit }: DrawerSectionProps) {
  const { notes, isLoading, error } = useTaskNotes(projectId, taskId);
  const { user } = useCurrentUser();
  const [query, setQuery] = useState('');

  // ADR-0133/1142: gate write controls off the server-derived verdict; fall back
  // to the client role rule only when the capability is absent.
  const editable = canEdit ?? canEditTask(userRole);
  const isAdmin = (userRole ?? 0) >= ROLE_ADMIN;

  // Which notes match the active search (body or author name). Empty query ⇒ all
  // match (full opacity, no counter). Matching is computed client-side over the
  // already-fetched list — no server round-trip (ADR-0143 dim-search).
  const { entries, matchCount } = useNotesSearch(notes, query);

  function isWithinEditWindow(note: TaskNote): boolean {
    if (!user || note.author?.id !== user.id) return false;
    return Date.now() - new Date(note.created_at).getTime() < EDIT_WINDOW_MS;
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading notes">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-semantic-critical" role="alert">
        Couldn&apos;t load notes.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {notes.length > 0 && (
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="flex-1 text-sm bg-neutral-surface border border-neutral-border rounded-control px-2 h-8
              text-neutral-text-primary placeholder:text-neutral-text-disabled
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
          {query.trim() !== '' && (
            <span
              role="status"
              aria-live="polite"
              className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap"
            >
              {matchCount} of {notes.length} notes
            </span>
          )}
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-sm text-neutral-text-secondary px-1">
          {editable ? 'No notes yet — capture the first decision or why.' : 'No notes yet.'}
        </p>
      ) : (
        <ol aria-label={`Notes — ${notes.length} total`} className="flex flex-col gap-2 list-none p-0">
          {entries.map(({ note: n, matches }) => (
            <NoteRow
              key={n.id}
              note={n}
              projectId={projectId}
              taskId={taskId}
              editable={editable}
              canDelete={editable && (n.author?.id === user?.id || isAdmin)}
              canEditBody={editable && isWithinEditWindow(n)}
              query={query}
              matches={matches}
            />
          ))}
        </ol>
      )}

      {editable && <NotesComposer projectId={projectId} taskId={taskId} />}
    </div>
  );
}
