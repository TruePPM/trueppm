Corrected the "Reproduce" claim on the *Computed, not guessed* page and its companion
*Agent oversight* page. Both described the agent-action log as covering every answer and
every refusal; the shipped record covers calls made with an `mcp:read`-scoped token plus
identity refusals of revoked or expired tokens, and the refusal constraint code and
projected impact sit outside the hashed body by design (ADR-0421). Both pages now state
the recorded scope, what is inside the hash and what is not, and declare
`documentedFor: "0.4"`.
