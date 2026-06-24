import { type ReactNode } from 'react';
import { NavLink } from 'react-router';

/**
 * Shared breadcrumb trail (ADR-0127). Canonicalizes the inline pattern that was
 * duplicated across SprintsView / RiskRegisterView. The last item is the current
 * page (`aria-current="page"`, non-link); earlier items link to their route.
 * `leading` lets a segment carry an adornment (e.g. the program identity square).
 */
export interface BreadcrumbItem {
  label: string;
  /** Route to link to. Omit for the current (last) segment. */
  to?: string;
  /** Optional adornment rendered before the label (e.g. ProgramIdentitySquare). */
  leading?: ReactNode;
}

export function Breadcrumb({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={['min-w-0', className ?? ''].join(' ')}>
      <ol className="flex items-center gap-1.5 min-w-0">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1.5 min-w-0">
              {i > 0 && (
                <span aria-hidden="true" className="shrink-0 text-chrome-text-secondary/60">
                  ›
                </span>
              )}
              {item.leading}
              {item.to && !isLast ? (
                <NavLink
                  to={item.to}
                  className="min-w-0 truncate text-[13px] text-chrome-text-secondary hover:text-chrome-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface rounded-control"
                >
                  {item.label}
                </NavLink>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={[
                    'min-w-0 truncate text-[13px]',
                    isLast ? 'font-medium text-chrome-text-primary' : 'text-chrome-text-secondary',
                  ].join(' ')}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
