import { BurnChart } from './BurnChart';
import { useProjectId } from '@/hooks/useProjectId';

export function ReportsView() {
  const projectId = useProjectId();

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-lg font-semibold text-neutral-text-primary">Reports</h1>
        <p className="mt-0.5 text-sm text-neutral-text-secondary">
          Burn charts and progress metrics for this project.
        </p>
      </div>

      <BurnChart projectId={projectId ?? undefined} />
    </div>
  );
}
