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
 * wayfinding (the leaf alone, switching via the rail drawer), the desktop branch
 * is the interactive pickers — never both, so the name text is never duplicated in
 * the a11y tree.
 *
 * The **program** segment passes `linkToCurrent` (#2669) — its name is a direct
 * link to the program's own Overview, separate from the switcher chevron, because
 * from a project route the program's own page was previously unreachable (picking
 * the checked row in the picker was an explicit no-op). The **project** segment
 * does not: its current entry already *is* the page you're on, so there is no
 * second destination to link to.
 */
export function LocationSwitcher() {
  const model = useLocationModel();
  const isMobile = useBreakpoint() === 'sm';

  if (model.suppressed) return null;

  if (isMobile) {
    // Non-interactive wayfinding, LEAF ONLY below md (#4238). Switching happens
    // through the rail drawer.
    //
    // It used to render `Project › Leaf` with `min-w-0 shrink-[9999]`, and on a
    // project route at 375–430px the bar hands it 0–47px: measured at 430, 24px of
    // project name, the chevron and 8px of leaf — "M ›" and a lone ellipsis that
    // read as a stray dash. No phone width fits both labels beside the right
    // cluster, so the project segment is dropped here.
    //
    // A rigid floor for the leaf is not the answer either: at 375 the right
    // region's own floor (the pinned chrome) leaves no room at all, and a floor
    // pushed the header 48–67px past the bar (mobile-chrome-clip.spec). So the nav
    // takes ONLY the leftover width — `grow basis-0 min-w-0`, never competing with
    // the status strip, which keeps #3505's order of sacrifice (wayfinding gives
    // first, and here it gives everything) — and is a size container, so the leaf
    // is drawn only when the leftover can hold a readable label (it truncates past
    // that) and is otherwise `sr-only`: still announced, never a fragment.
    return (
      <nav
        aria-label="Location"
        className="flex min-w-0 grow basis-0 items-center [container-type:inline-size]"
      >
        <span
          aria-current="page"
          className="sr-only text-sm font-medium text-neutral-text-primary [@container(min-width:2.5rem)]:not-sr-only [@container(min-width:2.5rem)]:truncate"
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
            // #2669: while browsing a project, the program segment's "current" row
            // is a genuinely different page (the program's own Overview) — link the
            // name there directly so there is a way back that isn't a picker no-op.
            linkToCurrent
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
