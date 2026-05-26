import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';

/**
 * The workspace fiscal-year start month (1–12), for fiscal quarter labelling
 * on the Schedule timeline (#755).
 *
 * Defaults to January (1) while the workspace settings query is loading or on
 * error, so the quarter math always has a usable anchor and the header never
 * fails to render. When the value is 1, fiscal quarters equal calendar
 * quarters and the mode toggle is hidden (no decision to make).
 */
export function useFiscalYearStartMonth(): number {
  const { data } = useWorkspaceSettings();
  return data?.fiscalYearStartMonth ?? 1;
}
