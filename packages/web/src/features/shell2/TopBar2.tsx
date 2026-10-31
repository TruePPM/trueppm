import { Fragment } from 'react';
import { Link } from 'react-router';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { modifierKeyLabel } from '@/lib/platform';
import { useLocationModel } from '@/features/shell/useLocationModel';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { CreateMenu } from '@/features/shell/CreateMenu';
import { SearchIcon } from '@/components/Icons';
import { programPath, projectPath } from '@/lib/refPath';
import { StatusSlot } from './StatusSlot';

interface Crumb {
  label: string;
  to?: string;
}

/**
 * The ONLY location in the app (shell spec §4). Program › project › leaf, with
 * a single "/" separator; never repeated in an eyebrow, a banner or a status
 * bar. The leaf is plain text because the context header's tab row owns view
 * switching — a dropdown here would be the second view switcher the v1 shell
 * had.
 */
function Breadcrumb() {
  const model = useLocationModel();
  // A phone shows the leaf only; the context header above the content already
  // names the project, and three truncated crumbs in 300px name nothing.
  const phone = useBreakpoint() === 'sm';
  const crumbs: Crumb[] = [];
  if (!model.suppressed && !phone) {
    if (model.program?.current) {
      crumbs.push({
        label: model.program.current.name,
        to: programPath(model.program.current, 'overview'),
      });
    }
    if (model.project?.currentId && model.project.currentName) {
      crumbs.push({
        label: model.project.currentName,
        to: projectPath({ id: model.project.currentId }, 'overview'),
      });
    }
  }
  crumbs.push({ label: model.leaf });
  const leaf = crumbs[crumbs.length - 1];
  return (
    <nav
      aria-label="Location"
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm text-p1-text-2"
    >
      {crumbs.slice(0, -1).map((c) => (
        <Fragment key={c.label}>
          <Link
            to={c.to ?? '#'}
            className="truncate rounded text-p1-text-2 no-underline hover:text-p1-text-1 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus"
          >
            {c.label}
          </Link>
          <span className="text-p1-text-3" aria-hidden="true">
            /
          </span>
        </Fragment>
      ))}
      <span className="truncate font-medium text-p1-text-1" aria-current="page">
        {leaf.label}
      </span>
    </nav>
  );
}

/**
 * 48px, at most six controls (shell spec §6): breadcrumb, the status slot, the
 * ⌘K trigger and Create. The page's own primary action lives in the page.
 */
export function TopBar2() {
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-p1-hairline px-3 md:pl-5">
      <Breadcrumb />
      <span className="flex-1" />
      <StatusSlot />
      <button
        type="button"
        onClick={() => openPalette(true)}
        className="hidden h-8 items-center gap-2 rounded-md border border-p1-hairline bg-p1-surface-0 px-2.5 text-xs text-p1-text-3 hover:border-p1-hairline-strong hover:text-p1-text-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus md:flex md:w-[220px] lg:w-[260px]"
      >
        <SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">Search or run a command</span>
        <kbd className="rounded border border-p1-hairline bg-p1-surface-2 px-1 font-mono text-xs leading-4 text-p1-text-2">
          {modifierKeyLabel()}K
        </kbd>
      </button>
      <CreateMenu />
    </header>
  );
}
