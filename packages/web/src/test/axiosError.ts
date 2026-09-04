import { AxiosError, type AxiosResponse } from 'axios';

/**
 * A **real** `AxiosError` carrying a status and a response body.
 *
 * Shared because the refusal helpers (`lib/apiError.ts`, `lib/writeRefusal.ts`)
 * branch on `axios.isAxiosError` and on `response.status`, so a hand-built
 * `{ isAxiosError: true, … }` object passes some branches and silently skips
 * others — and a test that passes a finished *string* in as a prop exercises the
 * slot, not the wiring, which is how eight surfaces shipped one hardcoded
 * sentence for every refusal (#3302, #3332).
 */
export function axiosRefusal(status: number, data: unknown): AxiosError {
  const err = new AxiosError(`Request failed with status code ${status}`);
  err.response = { status, data } as AxiosResponse;
  return err;
}

/**
 * A transport failure — the request left, nothing came back. `response` is
 * `undefined`, which is what separates "the server refused" from "the server
 * never answered".
 */
export function axiosNetworkError(): AxiosError {
  return new AxiosError('Network Error', AxiosError.ERR_NETWORK);
}
