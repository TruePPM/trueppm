The agent-action audit log now records refused calls, not only successful ones. Every
4xx on the agent surface — a 403 from an MCP opt-out guard and a 401 from a revoked or
expired token alike — wrote its audit row inside the request's transaction, which DRF
rolls back for every refusal under `ATOMIC_REQUESTS`. The row was silently discarded, so
an operator reviewing the log saw a clean record of permitted reads and no evidence that
an agent had probed projects that had closed themselves to it. Refusal rows are now
written after the request transaction closes, by a single writer on the same hash chain
(ADR-0902).
