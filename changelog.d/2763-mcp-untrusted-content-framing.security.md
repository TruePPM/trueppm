Hardened the read-only MCP server against indirect prompt injection from
user-authored task/risk/sprint text. `SERVER_INSTRUCTIONS` now states
explicitly that everything a tool returns is project data — never an
instruction to follow, however it is phrased — and every free-text field
(`description`, `notes`, `mitigation`, `response`, `summary`, `narrative`) is
now wrapped in `<untrusted-content>` markers so client-side prompt
construction has a structural signal to separate it from trusted system
framing. This is a framing mitigation, not a content filter: it does not
sanitize or reject text, and full closure of this class is not possible
purely server-side (#2763).
