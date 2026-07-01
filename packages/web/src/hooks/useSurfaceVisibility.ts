import { useProject, type SurfaceVisibility } from './useProject';

/**
 * The lossless default surface visibility used until the project detail loads.
 * Every surface is visible — hiding is opt-in, so a not-yet-loaded project never
 * flashes a surface hidden (which would be a worse first paint than showing it).
 */
const ALL_VISIBLE: SurfaceVisibility = {
  reporting: true,
  time_tracking: true,
  baselines: true,
  monte_carlo: true,
};

/**
 * Resolved visibility of the four toggleable leaf surfaces for a project
 * (ADR-0193, issue 956). Reads the server-computed `effective_surface_visibility`
 * (project override ?? methodology default) — the single web resolution path
 * consumed by the reports tab gate, the Schedule baseline surfaces, and the
 * Monte-Carlo forecast bar. Falls back to all-visible while loading or for an
 * anonymous/unknown project.
 *
 * Hide-only (ADR-0041): a false value hides the chrome; the route and endpoint
 * stay reachable and the data is always computed.
 */
export function useSurfaceVisibility(projectId: string | null | undefined): SurfaceVisibility {
  const { data } = useProject(projectId);
  return data?.effective_surface_visibility ?? ALL_VISIBLE;
}
