import type { DrawerSectionProps } from '@/lib/widget-registry';
import { HistoryTab } from '../HistoryTab';

/** History — wraps the existing HistoryTab; field-diff audit trail. */
export function HistorySection({ taskId, projectId }: DrawerSectionProps) {
  return <HistoryTab projectId={projectId} taskId={taskId} />;
}
