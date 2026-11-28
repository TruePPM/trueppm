import { describeWriteRefusal, type WriteRefusal } from '@/lib/writeRefusal';

/** The run finished but was not stored as the project's shared forecast. */
export class MonteCarloNotStoredError extends Error {
  constructor() {
    super("This run wasn't saved as the shared forecast. Only Schedulers and above can update it.");
    this.name = 'MonteCarloNotStoredError';
  }
}

/**
 * `describeWriteRefusal` for a run: a not-stored run is a client-raised error with
 * no HTTP body, which the generic helper would collapse to the fallback sentence.
 */
export function describeRunRefusal(error: unknown, fallback: string): WriteRefusal | null {
  if (error instanceof MonteCarloNotStoredError) {
    return { message: error.message, detail: null, retryable: false };
  }
  return describeWriteRefusal(error, fallback);
}
