import { Link } from 'react-router';
import type { ProjectRow } from './programHomeModel';

/** Projects in the program: the server's band word and its at-risk and overdue task counts. */
export function ProgramProjectsTable({ rows }: { rows: ProjectRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-p1-text-2">This program has no projects yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-p1-hairline bg-p1-surface-1">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Projects in this program</caption>
        <thead className="text-xs text-p1-text-2">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Project
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Health
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              At risk
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Overdue
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-p1-hairline">
              <td className="px-4 py-1">
                <Link
                  to={r.to}
                  className="inline-flex min-h-[44px] items-center font-medium text-p1-text-1 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-p1-focus"
                >
                  {r.name}
                </Link>
              </td>
              <td className="px-3 py-1 text-p1-text-1">{r.health ?? 'Not reported'}</td>
              <td className="px-3 py-1 text-right font-mono tabular-nums">{r.atRisk ?? '–'}</td>
              <td className="px-3 py-1 text-right font-mono tabular-nums">{r.overdue ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
