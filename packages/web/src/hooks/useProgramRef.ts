import { useContext } from 'react';
import { useParams } from 'react-router';
import { ProgramRefContext } from '@/router/refContext';

/**
 * The URL segment the active program is addressed by (its key, or its UUID when it
 * has none). Build in-app program links from this so they match the address bar;
 * never send it to the API. Mirrors `useProjectRef`.
 */
export function useProgramRef(): string | undefined {
  const resolved = useContext(ProgramRefContext);
  const { programId: param } = useParams<{ programId: string }>();
  return resolved?.ref ?? param;
}
