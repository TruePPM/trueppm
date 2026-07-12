# ADR-0368: Compact inline "why" on primary MCP answer tools

## Status
Accepted

## Context
The read-only MCP server (ADR-0186) exposes the primary answer tools an AI agent
reaches for first: `get_schedule_summary`, `get_monte_carlo_forecast`, `whatif`,
and `get_task`. Today each returns bare computed numbers — a forecast date, a P80,
a delta — with no explanation of *why*. The causal "why" (the binding predecessor
of a schedule date, the risk-premium driver of a Monte Carlo percentile) exists,
but only behind a *separate* explicit tool, `get_schedule_derivation` (ADR-0218,
#1058). So "computed, not guessed" is always one extra round-trip away from every
answer, and an agent that stops at the primary answer presents a number it cannot
justify.

ADR-0218 anticipated this exact gap: it deferred "a uniform provenance surface
across all MCP-readable computed endpoints" as non-blocking follow-up, and noted
that in the interim `get_schedule_derivation` *is* the provenance, reachable only
on demand. #1848 closes that gap for the primary tools by making an answer
**explained by default** — a compact one-line "why" plus a pointer to the full
derivation, not the full contribution chain inlined into every response.

Scope note: this is the *causal* "why" (ADR-0218 derivation content). It is
distinct from — and complementary to — the ADR-0112 §2 signed-answer `_provenance`
/ `AnswerStamp` reproducibility envelope (engine version, input hash, computed_at),
which remains deferred and unimplemented. #1848 does **not** implement that
envelope; it surfaces the causal explanation the engine already computes.

P3M layer: Programs and Projects (single-project CPM / Monte Carlo). OSS —
the AI-agent-actor read surface is OSS (ADR-0112/0186); org-level AI governance is
the Enterprise counterpart.

## Decision
Attach a compact `"why"` block to each of the four primary answer tools, built
**entirely by distilling data the tool already fetches in its own response** — no
extra endpoint call, no recompute, no extra DB query. The full contribution chain
stays in the deep-dive `get_schedule_derivation` tool, which every `"why"` points
to via a `see_also` field.

Per-tool `"why"` content (all distilled from the tool's existing response):

| Tool | Distilled from (already in-response) | Inline `why` |
|------|--------------------------------------|--------------|
| `get_monte_carlo_forecast` | `cpm_finish`, `delta_vs_cpm.p80`, `sensitivity[0]` | one-line explanation, `cpm_finish`, `risk_premium_days` (P80 over CPM), `top_driver` (`task_id`+`index`), `see_also` |
| `whatif` | `delta_vs_current.p80`, `critical_path_changed` | explanation, `delta_p80_days`, `critical_path_changed`, `see_also` |
| `get_schedule_summary` | `cpm_finish`, `critical_task_count` | explanation, `cpm_finish`, `critical_task_count`, `see_also` |
| `get_task` | `is_critical`, `total_float` | explanation, `is_critical`, `total_float_days` (only if present), `see_also` |

`get_task` and `get_schedule_summary` deliberately do **not** compute the CPM
binding predecessor inline. That requires a full `schedule()` pass through the
engine (`derive_value` runs `schedule(project)` when no precomputed result is
passed); doing it on every `get_task` — the most-called tool — would be a per-call
CPM run, and backlog tasks are not in the CPM network at all (`derive_value` would
raise). The inline `why` therefore cites the cheaply-available persisted signals
(`is_critical`, `total_float`) and points to `get_schedule_derivation` for the
binding predecessor and per-constraint contributions.

Home: the MCP presentation layer (`packages/mcp/src/trueppm_mcp/tools.py`). No API
change is required — every derivation input the `why` needs is already in the
response the tool fetches. This keeps the LLM-facing shaping concern where ADR-0186
already puts it, and leaves the web API contract untouched.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| A. Distill `why` in the MCP layer from already-fetched data (chosen) | Zero added cost per call; scope-safe by construction; no API/web contract change; tiny diff; fits ADR-0186 compaction contract | `why` limited to fields already in the primary response (acceptable — deep-dive tool covers the rest) |
| B. Embed a `why`/`_provenance` block in each API endpoint's response | Benefits web clients too; one canonical shape | Changes web API + OpenAPI contract for all clients; larger blast radius; `get_task` binding-predecessor case still needs a full CPM pass server-side |
| C. Have the MCP tool make a second GET to `get_schedule_derivation` per answer | Full binding-predecessor `why` inline | Extra HTTP round-trip per primary call; a full `schedule()` CPM pass per `get_task`; fails for backlog tasks — a per-call perf regression on the hottest tools |
| D. Do nothing (leave provenance only in the separate tool) | No work | The status quo #1848 exists to fix; answers stay unexplained by default |

## Consequences
- **Easier**: every primary MCP answer is self-justifying — an agent can cite the
  risk premium / binding driver without a second call, and knows exactly which
  tool to call for the full chain.
- **Harder**: nothing structurally; the `why` is bounded to what the primary
  response already carries. Richer explanation remains a deliberate opt-in via
  `get_schedule_derivation`.
- **Risks**: (1) response size — mitigated by keeping `why` to a handful of scalar
  fields + a one-line string, and by the existing compaction contract dropping
  empty entries. (2) Scope leak — *prevented by construction*: the `why` is
  distilled only from the token's own already-permission-filtered response, so a
  field the token cannot see (sprint-internal restriction, velocity-signal
  suppression, both enforced upstream at the API) is simply absent from the input
  and therefore absent from the `why`. A regression test asserts a token whose
  response lacks a restricted field gets a `why` that also lacks it.

## Implementation Notes
- P3M layer: Programs and Projects.
- Affected packages: `mcp` (only). No `api`, `scheduler`, `web`, or `helm` change.
- Migration required: no.
- API changes: no — the endpoints already return every field the `why` distills.
- OSS or Enterprise: OSS (`trueppm-suite`).

### Durable Execution
1. Broker-down behaviour: N/A — pure synchronous read/presentation path; the tools
   issue `GET`s and shape the result. Zero async side effects, zero writes.
2. Drain task: N/A — no async work is enqueued.
3. Orphan window: N/A — no outbox rows.
4. Service layer: N/A — the derivation values are already computed by the existing
   endpoints (`MonteCarloLatestView`, `ProjectForecastView`, the what-if view);
   the MCP tool only distills the already-returned payload.
5. API response on best-effort dispatch: N/A — synchronous read; no dispatch.
6. Outbox cleanup: N/A.
7. Idempotency: inherently idempotent — a pure function of the fetched response;
   the same read yields the same `why`.
8. Dead-letter / failure handling: N/A — a failed upstream GET surfaces as the
   existing `ApiError`; the `why` is simply omitted when its source fields are
   absent (defensive `.get`), never fabricated.
