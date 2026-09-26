import { useContext } from 'react';
import { useParams } from 'react-router';
import { ProjectRefContext } from '@/router/refContext';

/**
 * The URL segment the active project is addressed by — its current key, or its
 * UUID when it has none (ADR-1237 §7).
 *
 * Use this, not {@link useProjectId}, to build **in-app links** under the current
 * project (`` `/projects/${ref}/board` ``): a link built from the UUID still works,
 * but it no longer matches the address bar, so `NavLink` active-state and any
 * pathname comparison would read "not here" on a key URL. Never send it to the API.
 */
export function useProjectRef(): string | undefined {
  const resolved = useContext(ProjectRefContext);
  const { projectId: param } = useParams<{ projectId: string }>();
  return resolved?.ref ?? param;
}
