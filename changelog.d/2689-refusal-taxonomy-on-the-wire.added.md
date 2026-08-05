A refused API call made with an API token now says why. The 401/403 body carries a
structured `refusal` — verdict, reason (`identity` or `policy`), and the constraint that
fired when it is safe to name — and the MCP client surfaces it on the exception it
raises, so an agent operator sees the reason rather than a bare HTTP status. Constraints
that would name a resource the caller cannot read are withheld. Responses to human
sign-in sessions are unchanged.
