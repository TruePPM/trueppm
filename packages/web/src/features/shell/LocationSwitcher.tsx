import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { LocationSegment } from './LocationSegment';
import { useLocationModel } from './useLocationModel';

/** `›` separator, rendered only between two present segments (never leading/trailing). */
function Chevron() {
  return (
    <span aria-hidden="true" className="mx-1 shrink-0 text-neutral-text-disabled">
      ›
    </span>
  );
}

/**
 * Top-bar location switcher (issue #1643, ADR-0203) — the `Program › Project ›
 * Leaf` wayfinding that replaces the former breadcrumb + in-chrome
 * `ProjectSwitcher`. The **program** and **project** segments are interactive
 * pickers (`LocationSegment`); the **leaf** is a plain `aria-current` "you are
 * here" label, never a dropdown — the left rail owns view switching (post-#1642),
 * so the leaf is the one deliberate dedup.
 *
 * Route-adaptive (see `useLocationModel`): off a project (My Work, Notifications,
 * the listing pages) the project segment becomes an unanchored "Jump to project…"
 * placeholder picker (#2102, ADR-0508 D3) so any project is one hop away —
 * `[Jump to project…] › Leaf`, collapsing to the leaf alone with zero projects; on
 * a program route the project segment drops; a project with no program drops the
 * program segment. It self-suppresses on `/settings/*` (rule 123) — the
 * SettingsShell owns the scope switcher there.
 *
 * Single render across breakpoints (rule 211): the mobile branch is non-interactive
 * wayfinding (`Project › Leaf`, switching via the rail drawer), the desktop branch
 * is the interactive pickers — never both, so the name text is never duplicated in
 * the a11y tree.
 */
export function LocationSwitcher() {
  const model = useLocationModel();
  const isMobile = useBreakpoint() === 'sm';

  if (model.suppressed) return null;

  if (isMobile) {
    // Non-interactive wayfinding: Project › Leaf (program omitted to save width;
    // switching happens through the rail drawer).
    return (
      <nav aria-label="Location" className="flex min-w-0 items-center">
        {model.project?.currentName && (
          <>
            <span className="max-w-[8rem] truncate text-sm font-medium text-chrome-text-secondary">
              {model.project.currentName}
            </span>
            <Chevron />
          </>
        )}
        <span
          aria-current="page"
          className="max-w-[10rem] truncate text-sm font-medium text-neutral-text-primary"
        >
          {model.leaf}
        </span>
      </nav>
    );
  }

  const programLeading = model.program?.current ? (
    <ProgramIdentitySquare program={model.program.current} size="sm" />
  ) : undefined;

  return (
    <nav aria-label="Location" className="flex min-w-0 items-center">
      {model.program && (
        <>
          <LocationSegment
            noun="program"
            options={model.program.options}
            currentId={model.program.current?.id}
            currentName={model.program.current?.name}
            leading={programLeading}
          />
          <Chevron />
        </>
      )}
      {model.project && (
        <>
          <LocationSegment
            noun="project"
            options={model.project.options}
            currentId={model.project.currentId}
            currentName={model.project.currentName}
            currentSubtitle={model.project.currentMethodologyLabel}
            placeholder="Jump to project…"
            placeholderAriaLabel="Jump to a project"
          />
          <Chevron />
        </>
      )}
      <span
        aria-current="page"
        className="max-w-[10rem] truncate text-sm font-medium text-neutral-text-primary"
      >
        {model.leaf}
      </span>
    </nav>
  );
}
