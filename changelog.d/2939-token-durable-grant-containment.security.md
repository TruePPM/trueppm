- **Closed three token/session containment gaps flagged by the #2877/#2878 follow-up
  audit**: a leaked personal access token can no longer rotate a project's
  git-automation webhook secret or mint a public share link (`IsNotTokenAuthenticated`
  now covers both), and off-boarding plus the `revoke_api_tokens --all`
  full-compromise sweep now also revoke a departing member's share links and clear
  any git-automation secret they configured — the two durable, non-token grants that
  previously outlived every revocation lever. The mobile sync pull (`GET
  /api/v1/projects/{id}/sync/`) is now bounded by the default per-account throttle
  instead of resolving to no throttle at all. `ProgramViewSet`'s catch-all
  permission fallback is membership-bound rather than any-authenticated-user, so a
  future unsafe action added without an explicit role gate fails closed instead of
  silently opening.
