import { useEffect, useRef, useState } from 'react';
import { useProjects } from '@/hooks/useProjects';
import { useAssignProjectToProgram } from '@/hooks/useProgramMutations';
import {
  MethodologyFilter,
  METHODOLOGY_LABEL,
  type MethodologyFilterValue,
} from './MethodologyFilter';

interface Props {
  programId: string;
  programName: string;
  onClose: () => void;
}

/**
 * Modal picker for assigning a project to the current program (ADR-0070).
 *
 * Lists the user's projects in two groups:
 *  - **Standalone** — `programId === null`, can be assigned directly.
 *  - **In another program** — labelled with the current program; selecting moves it.
 *
 * Projects already in THIS program are filtered out client-side. Single-select
 * in v1 — multi-select picker is a v1.1 follow-up.
 *
 * Server enforces the cross-permission constraint (caller must be Project ADMIN
 * on the project AND Program ADMIN on the new program). When that fails, the
 * API returns a 400 with an actionable message which is surfaced inline.
 */
export function AddProjectToProgramModal({ programId, programName, onClose }: Props) {
  const { data: allProjects, isLoading } = useProjects();
  const assignProject = useAssignProjectToProgram();

  const [search, setSearch] = useState('');
  const [methodologyFilter, setMethodologyFilter] = useState<MethodologyFilterValue>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const projects = allProjects ?? [];
  // Exclude projects already in this program (no-op move) — the API silently
  // succeeds for those but it's a confusing UX to offer them.
  const candidates = projects.filter((p) => p.programId !== programId);

  const q = search.trim().toLowerCase();
  // Both facets are client-side over the already-cached project list (issue 564) — no
  // extra API call. Search and methodology narrow independently.
  const matches = candidates.filter(
    (p) =>
      (!q || p.name.toLowerCase().includes(q)) &&
      (methodologyFilter === 'ALL' || p.methodology === methodologyFilter),
  );
  // Candidates exist but the active search/filter hides them all — distinct from
  // "no candidates at all", so the user knows to widen rather than create.
  const noMatches = candidates.length > 0 && matches.length === 0;

  const standalone = matches.filter((p) => p.programId === null);
  const elsewhere = matches.filter((p) => p.programId !== null);

  async function handleSubmit(): Promise<void> {
    if (!selectedId) return;
    setError(null);
    try {
      await assignProject.mutateAsync({ projectId: selectedId, programId });
      onClose();
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : 'Failed to add project.';
      setError(message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-heading"
        className="flex w-full max-w-lg flex-col rounded-card border border-neutral-border bg-neutral-surface"
      >
        <header className="border-b border-neutral-border p-6">
          <h2 id="add-project-heading" className="text-lg font-semibold text-neutral-text-primary">
            Add project to &ldquo;{programName}&rdquo;
          </h2>
          <p className="mt-2 text-xs text-neutral-text-secondary">
            <span aria-hidden="true">ⓘ </span>
            Project membership is independent. Adding a project to a program does not grant
            program members access to that project (or vice versa).
          </p>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <input
            id="project-search"
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects"
            className="w-full rounded-control border border-neutral-border bg-neutral-surface px-3 py-2 text-sm
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          />

          {!isLoading && candidates.length > 0 && (
            <MethodologyFilter value={methodologyFilter} onChange={setMethodologyFilter} />
          )}

          {isLoading && (
            <div className="mt-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  aria-hidden="true"
                  className="h-9 motion-safe:animate-pulse rounded-control bg-neutral-surface-raised"
                />
              ))}
            </div>
          )}

          {!isLoading && candidates.length === 0 && (
            <p className="mt-6 text-sm text-neutral-text-secondary">
              No other projects available to add. Create a new project from the sidebar,
              then assign it here.
            </p>
          )}

          {!isLoading && noMatches && (
            <p role="status" className="mt-6 text-sm text-neutral-text-secondary">
              No projects match. Try a different search or methodology.
            </p>
          )}

          {!isLoading && standalone.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
                Standalone projects ({standalone.length})
              </h3>
              <ul className="divide-y divide-neutral-border rounded-card border border-neutral-border">
                {standalone.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-surface-raised">
                      <input
                        type="radio"
                        name="project"
                        value={p.id}
                        checked={selectedId === p.id}
                        onChange={() => setSelectedId(p.id)}
                        className="h-4 w-4 text-brand-primary
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                      />
                      <span className="flex-1 truncate text-sm text-neutral-text-primary">
                        {p.name}
                      </span>
                      {/* Methodology badge (issue 564) — confirm the right "Riverside"
                          before assigning. tppm-mono matches the Projects-tab row. */}
                      <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                        {METHODOLOGY_LABEL[p.methodology]}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isLoading && elsewhere.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
                In another program ({elsewhere.length})
              </h3>
              <p className="mb-2 text-xs text-neutral-text-secondary">
                Selecting one will move it to this program.
              </p>
              <ul className="divide-y divide-neutral-border rounded-card border border-neutral-border">
                {elsewhere.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-surface-raised">
                      <input
                        type="radio"
                        name="project"
                        value={p.id}
                        checked={selectedId === p.id}
                        onChange={() => setSelectedId(p.id)}
                        className="h-4 w-4 text-brand-primary
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                      />
                      <span className="flex-1 truncate text-sm text-neutral-text-primary">
                        {p.name}
                      </span>
                      {/* Methodology badge (issue 564) — confirm the right "Riverside"
                          before assigning. tppm-mono matches the Projects-tab row. */}
                      <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                        {METHODOLOGY_LABEL[p.methodology]}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="border-t border-neutral-border px-6 py-2 text-xs text-semantic-critical">
            {error}
          </p>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-border p-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!selectedId || assignProject.isPending}
            className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
              hover:bg-brand-primary/90 disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {assignProject.isPending ? 'Adding…' : 'Add project'}
          </button>
        </footer>
      </div>
    </div>
  );
}
