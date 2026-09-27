import { createContext } from 'react';

/**
 * What a route boundary resolved its `:projectId` / `:programId` param to
 * (ADR-1237 §7). Provided only once resolution has succeeded, so every component
 * below the boundary can rely on `id` being the object's UUID.
 */
export interface ResolvedRef {
  /** The object's UUID — what every API call takes. */
  id: string;
  /**
   * The URL segment the object is addressed by: its current key, or its UUID when
   * it has none. Build in-app links from this (not from `id`) so they match the
   * address bar and `NavLink` active-state keeps working on key URLs.
   */
  ref: string;
}

/** Provided by `ProjectRefBoundary`; read through `useProjectId()` / `useProjectRef()`. */
export const ProjectRefContext = createContext<ResolvedRef | null>(null);

/** Provided by `ProgramRefBoundary`; read through `useProgramId()` / `useProgramRef()`. */
export const ProgramRefContext = createContext<ResolvedRef | null>(null);
