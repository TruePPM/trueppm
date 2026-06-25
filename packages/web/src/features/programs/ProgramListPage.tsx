import { useState } from 'react';
import { useNavigate } from 'react-router';
import { usePrograms } from '@/hooks/usePrograms';
import { ProgramCard } from './ProgramCard';
import { NewProgramModal } from './NewProgramModal';
import { UngroupedProjectsSection } from './UngroupedProjectsSection';
import { ImportProgramButton } from './ImportProgramButton';
import { LoadSampleButton } from './LoadSampleButton';

/**
 * /programs — list of programs the current user is a member of (ADR-0070).
 *
 * Empty state hero introduces the concept and provides a single "create first
 * program" CTA. Otherwise renders a responsive card grid (1/2/3 columns).
 */
export function ProgramListPage() {
  const { data: programs, isLoading, error } = usePrograms();
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const isEmpty = !isLoading && !error && programs && programs.length === 0;

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-border px-6 py-4">
        <h1 className="text-lg font-semibold text-neutral-text-primary">Programs</h1>
        <div className="flex items-center gap-2">
          <LoadSampleButton variant="header" />
          <ImportProgramButton variant="header" />
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
              hover:bg-brand-primary/90
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + New program
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading && (
          <ul aria-label="Loading programs" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <li
                key={i}
                aria-hidden="true"
                className="h-32 animate-pulse rounded-card bg-neutral-surface-raised"
              />
            ))}
          </ul>
        )}

        {error && (
          <p role="alert" className="text-sm text-semantic-critical">
            Failed to load programs — please refresh.
          </p>
        )}

        {isEmpty && (
          <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
            <h2 className="text-base font-semibold text-neutral-text-primary">
              Programs group related projects
            </h2>
            <p className="mt-2 text-sm text-neutral-text-secondary">
              Create a program when you&rsquo;re managing several related projects and want a shared
              backlog or combined burndown. New to TruePPM? Load the demo to explore a populated
              program.
            </p>
            <div className="mt-6 flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="h-10 rounded-control bg-brand-primary px-5 text-sm font-medium text-white
                  hover:bg-brand-primary/90
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                + Create your first program
              </button>
              <p className="text-xs text-neutral-text-secondary">or</p>
              <LoadSampleButton />
              <ImportProgramButton variant="hero" />
            </div>
          </div>
        )}

        {!isLoading && !error && programs && programs.length > 0 && (
          <>
            <ul aria-label="Programs" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {programs.map((p) => (
                <ProgramCard key={p.id} program={p} />
              ))}
            </ul>
            {/* Standalone projects that aren't in any program (ADR-0171, #697).
                Self-hides when there are none. */}
            <UngroupedProjectsSection />
          </>
        )}
      </div>

      {showCreate && (
        <NewProgramModal
          onClose={() => setShowCreate(false)}
          onCreated={(programId) => {
            setShowCreate(false);
            void navigate(`/programs/${programId}/projects`);
          }}
        />
      )}
    </div>
  );
}
