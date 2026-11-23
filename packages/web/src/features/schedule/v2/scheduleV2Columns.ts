/**
 * The client flag that mounts shell v2. Duplicated from `shell2/ShellGate` on
 * purpose: importing that module from the Schedule chunk would pull both app
 * shells into the lazy Schedule bundle for the sake of one string.
 */
export const SCHEDULE_SHELL_V2_FLAG = 'shell_v2';

const LABELS: Record<string, string> = {
  wbs: 'ID',
  task: 'Task',
  links: 'Links',
  dur: 'Duration',
  start: 'Start',
  finish: 'Finish',
  progress: '% complete',
  owner: 'Owner',
  totalFloat: 'Total float',
  freeFloat: 'Free float',
};

/** The overflow's Columns section names each grid column as its header does. */
export function v2ColumnLabel(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
