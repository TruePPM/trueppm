import type { DrawerSectionProps } from '@/lib/widget-registry';
import { BaselineTab } from '../BaselineTab';

/** Baseline — wraps the existing BaselineTab; baseline vs current comparison. */
export function BaselineSection({ taskId, projectId }: DrawerSectionProps) {
  return <BaselineTab projectId={projectId} taskId={taskId} />;
}
