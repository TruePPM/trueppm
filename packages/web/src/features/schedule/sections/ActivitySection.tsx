import type { DrawerSectionProps } from '@/lib/widget-registry';
import { ActivityLog } from '../ActivityLog';

/** Activity section — human-readable event timeline for the task detail drawer (#307). */
export function ActivitySection({ taskId, projectId }: DrawerSectionProps) {
  return <ActivityLog projectId={projectId} taskId={taskId} />;
}
