import { Navigate, useParams } from 'react-router';
import { buildResetConfirmPath } from './resetLink';

/**
 * Compatibility shim for reset links minted before #3553.
 *
 * Until #3553 the emailed link carried the credential in the path
 * (`/reset-password/confirm/:uid/:token`). Tokens live 30 minutes, so the window
 * is short — but it is not zero, and a user who clicks a link that was in their
 * inbox when the deploy happened should land on the form, not on a 404.
 *
 * `replace` is load-bearing, not a detail: it swaps the path-form URL out of the
 * history entry instead of pushing a second one, so the credential-bearing
 * pathname never becomes a Back-button destination and never sits in the address
 * bar for the rest of the session. The path form is still exported by the two
 * telemetry surfaces for the instant it is mounted, which is exactly why the
 * scrub in `telemetry.ts` covers `/reset-password/confirm/*` as well.
 */
export function ResetPasswordLegacyLinkRedirect() {
  const { uid = '', token = '' } = useParams<{ uid: string; token: string }>();
  return <Navigate to={buildResetConfirmPath({ uid, token })} replace />;
}
