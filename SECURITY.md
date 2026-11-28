# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitLab issues.**

Report vulnerabilities privately through either channel:

- **Email** — **security@trueppm.com** (preferred).
- **Confidential GitLab issue** — open an issue in [`trueppm/trueppm`](https://gitlab.com/trueppm/trueppm/-/issues/new) and tick **"This issue is confidential"** so it is visible only to project members. Use this if you cannot send email or want the discussion tracked in GitLab.

Include:
- Description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected version(s)
- Any suggested mitigations you have identified

### Response timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | 2 business days |
| Initial assessment | 5 business days |
| Status update | Every 7 days until resolved |
| Fix merged to `main` | Within 30 days for Critical/High; 90 days for Medium/Low |
| Fix released | In the next release of the line under development — see [Release cadence](#release-cadence) |

The two are deliberately separate rows. Before `1.0.0` there is no backport path, so a
merged fix reaches you when the next release is cut, not on its own clock. If you need
the fix sooner than that, `main` carries it and is buildable — say so in the report
thread and we will tell you the commit.

We will credit reporters in the release notes unless anonymity is requested.

### Safe harbor

We support responsible security research and want to make it safe to report
what you find. We will **not** pursue or support legal action against you for
security research and vulnerability disclosure conducted in good faith and
consistent with this policy — that is, research that:

- respects user privacy and does not access, modify, or destroy data beyond the
  minimum needed to demonstrate the vulnerability;
- does not degrade, disrupt, or deny service to others (no denial-of-service,
  no automated high-volume scanning against shared infrastructure);
- targets only assets in the [Scope](#scope) section below, on infrastructure
  you own or are explicitly authorized to test; and
- gives us a reasonable opportunity to remediate before any public disclosure.

If you are unsure whether a specific test is authorized, ask first at
**security@trueppm.com** and we will clarify. This safe harbor does not extend
to actions that violate applicable law, and it does not waive the rights of
third parties who are not party to this policy.

## Supported Versions

| Version | Security patches |
|---------|-----------------|
| `main` (unreleased) | ✅ Fixes land here first |
| Latest tag (`0.3.0-alpha.3`) | ⚠️ Fixed forward — patched by the next release, not by backport |
| Any earlier tag | ❌ No support |

**Pre-`1.0.0`, "supported" means fixed forward.** TruePPM is alpha, and the only
maintained line is the one under development. A security fix is merged to `main` and
ships in the next release; nothing is cherry-picked back onto an existing tag, and
`scripts/release.sh` has no from-tag mode to do it with. Running the latest tag means
running a build that does not yet carry the fixes merged since it was cut — check
[`docs/maintainers/security-release-cadence.md`](docs/maintainers/security-release-cadence.md)
or `changelog.d/*.security.md` on `main` for what is outstanding, or build from `main`.

Once `1.0.0` is released, the two most recent minor versions will receive security
backports, and this table changes accordingly.

## Disclosure Policy

TruePPM follows **coordinated disclosure**:

1. Reporter submits privately.
2. We confirm, investigate, and develop a fix.
3. We agree on a disclosure date — typically 90 days from report, sooner if a fix is ready.
4. We publish a GitLab Security Advisory naming the fixing commit. The fix ships in the
   next release of the line under development; before `1.0.0` we do not cut a patch
   release against an older tag (see [Release cadence](#release-cadence)).
5. Reporter may publish their own write-up after the advisory is public.

## Release cadence

**We cut an out-of-band release when a fix changes the artifact you are running.**

Severity is not the trigger, and this catches people out, so it is worth being explicit:

- A HIGH advisory in a **build-toolchain** package — a `devDependency`, a lockfile-only
  transitive under eslint/babel/metro/Astro, anything reached only by the documentation
  site — runs on the machine that compiles the release, never inside it. If you are
  running a released image, you were never exposed. We land the bump and move on; there
  is no release.
- A MODERATE in **shipped runtime code** — `packages/api`, `packages/web`,
  `packages/scheduler`, `packages/mcp`, `packages/mobile`, `packages/helm`, or a
  dependency any of them actually loads — is in the artifact on your cluster. That is
  what a release is for.

If you are unsure which side a given advisory falls on, ask at **security@trueppm.com**
and we will tell you. The maintainer-side rule, the worked edge cases, and the triage of
every pending fix are in
[`docs/maintainers/security-release-cadence.md`](docs/maintainers/security-release-cadence.md).

## Scope

In scope: the TruePPM API (`packages/api`), web frontend (`packages/web`), scheduling engine (`packages/scheduler`), Helm chart (`packages/helm`), and the Docker Compose production stack.

Out of scope: the documentation website itself (`packages/website`), third-party dependencies (report those upstream), and findings that require physical access to the host.

## Threat model: the refusal guards and the agent-action chain

This section states what two mechanisms defend against, and what they do not. It
describes the code as it is on `main`; anything not yet shipped is in future tense and
names its issue. It is a model of the mechanisms, not an audit of the product, and it
is not a certification.

### What exists today, and what does not

* **Refusal guards (pause and capability scope ship in 0.5).** An agent is a personal
  API token that carries `mcp:read` and not a full scope. Its calls pass guards that
  refuse with a typed envelope: a paused agent (`agent_paused`), a read outside the
  agent's capability scope (`capability_scope`), and a token that fails identity checks
  (`token_identity`). The pause and per-area scope guards are on `main` and in no
  release tag yet (the latest is v0.4.0); they ship in 0.5. The scope is a per-area
  grant (schedule, dependencies, resources, baselines); the effective scope is the grant
  intersected with the principal's *current* roles, evaluated on every call and never
  cached (`apps/projects/agent_scope.py`). `write` will not be grantable in 0.5, and
  that refusal is enforced on the server, not by the UI.
* **Scheduling refusals (not shipped).** The constraints that would refuse an
  infeasible *schedule change* (`graph_validation`, `sprint_sovereignty`, `rollup_lock`,
  `engine_referee`) are reserved codes with no producer. They will ship with the gated
  write path in 0.6 (ADR-0362). Until then the engine refuses nothing on an agent's
  behalf, because an agent cannot write.
* **The `AgentAction` chain (shipped).** Each agent read or refusal that the guards
  record is appended as one row. Each row stores a gap-free `sequence` and
  `record_hash = sha256(prev_hash || canonical(record))`
  (`apps/agents/canonical.py`, `services.py`). Appends are serialized under a lock on
  a singleton chain head and are fail-closed: if the append fails, the request rolls
  back. Refusal rows are written after the request transaction closes so a refusal's
  rollback does not discard them (`apps/agents/middleware.py`).

### Assets

* The plan of record (tasks, dependencies, baselines, resource data).
* The agent-action chain.
* API tokens: they authenticate agents and are bearer credentials.

### Actors

1. An agent acting within its token's scope.
2. An agent attempting reads outside its scope, or after being paused or revoked.
3. A token holder using a full-scope token through the REST API.
4. An operator with write access to the database.

### What the mechanisms guarantee

| Guarantee | Basis |
|---|---|
| A controlled agent can read only what its principal can read, narrowed by its per-area grant. Demoting the principal shrinks the agent on the next call. | `effective_scope`, `can_read_area`; `tests/apps/agents/test_agent_control_plane.py` |
| A grant cannot be raised above the principal's ceiling, whoever edits it, and `write` cannot be granted. | `validate_grant`; same test file |
| Pause and revoke take effect on the next call. The paused-agent message never names the person who paused it. | same test file |
| A refusal reveals only the caller's own credential state (`DISCLOSABLE_CONSTRAINTS`), never the existence or state of a resource the caller cannot read. | `apps/agents/refusal.py` |
| Humans and agents are refused by the same role checks: an agent token resolves to its owner, so each view's own RBAC applies on top of the scope. | `test_agent_never_exceeds_principal_and_demotion_shrinks_it` in `tests/apps/agents/test_agent_control_plane.py`; `agent_scope.py` module docstring |
| `manage.py audit_verify` *detects* edits to a row, reordering, gaps, and deleted rows, including a prune that left no checkpoint. | `apps/agents/services.py` (`verify_chain`), `management/commands/audit_verify.py` |

### What the mechanisms do not guarantee

* **Tamper-proof against a database writer.** The chain is a local integrity check.
  An operator with database write access can prune history and write a matching
  checkpoint, or recompute every hash after an edit; `audit_verify` cannot tell. The
  checkpoint is an unauthenticated continuity anchor, not a signature. Third-party
  proof that history was not truncated is an Enterprise capability
  (trueppm/trueppm-enterprise#189).
* **Coverage of every credential.** Token-authenticated writes are not yet in the
  chain (#4193). A full-scope personal token (`api:full`, and `legacy:full` on tokens
  minted earlier) acts as its owner with that owner's full permissions, is not governed
  by the capability scope, and is not an agent for the pause control. Mint `mcp:read`
  tokens for agents.
* **Data an agent was legitimately given.** Scope limits what an agent can read; it
  cannot limit what the agent does with it afterwards, such as relaying it to a
  third party.
* **Row order in the program overview.** Agent reads of the program Schedule area
  withhold the Baselines, Dependencies and Resources figures they embed (task baseline
  fields, overview SPI and utilization, rollup variances and health, status-update
  baseline dates, program schedule links, sprint member hours). The overview lists its
  project rows sorted by how far each slips against its commitment date, so an agent
  without Baselines read can still infer that ranking from the order, though not the
  dates or day counts (#5201).
* **Two counts that still name another area's data.** The program projects list
  serves each project's `baseline_count` without Baselines read, and the sprint
  reforecast preview serves `unmodeled_predecessor_ids` without Dependencies read
  (#5201).
* **Commitment fields in the forecast reads.** The project forecast, the latest Monte
  Carlo result and the Monte Carlo what-if (`/forecast/`, `/monte-carlo/latest/`,
  `/monte-carlo/whatif/`) are Schedule-area reads that still return
  `commitment_date`, `commitment_source` and the `p80_delta_vs_commitment_*` fields
  to an agent without Baselines read. The commitment date is the active baseline's
  finish when one exists, so these reads disclose it. Withholding them is #5202.

### Out of scope

Compromise of the host or the secrets store, theft of a token from the agent's own
machine, and denial of service by a token holder who is within their rate limits.

### Review

Review this section when #4193 lands, when the gated write path (0.6) ships its
scheduling refusals, and whenever the chain's canonical fields change.

## Automated security checks

Every merge request and every push to `main` runs a layered set of automated,
merge-blocking checks so security regressions are caught before release:

| Check | Tool | What it catches |
|-------|------|-----------------|
| Secret scanning | gitleaks | Hardcoded credentials, keys, and tokens (also a pre-commit hook) |
| Static analysis (SAST) | bandit, semgrep | Insecure Python/JS/TS/Django patterns |
| Dependency CVEs (SCA) | osv-scanner, cargo-deny | Known-vulnerable Python, npm, and Rust dependencies |
| Container / IaC | trivy | Dockerfile and Helm misconfigurations; image CVEs before push |
| License compliance | pip-licenses, license-checker, cargo-deny | Copyleft licenses incompatible with the Apache-2.0 core |

These are enforcement gates, not advisories: a pipeline that surfaces an
unignored finding blocks the merge. Suppressions are scoped and documented in
the relevant config (`.gitleaks.toml`, `osv-scanner.toml`, `.trivyignore.yaml`,
`deny.toml`) so they stay auditable rather than silently masking findings.

## Supply-chain verification

Every published artifact — the `api`/`web` container images, the Helm chart,
and the `trueppm-scheduler` / `trueppm-mcp` / `trueppm-api` PyPI packages — is
Cosign-signed (or PEP 740-attested, for the PyPI packages) via GitLab OIDC
Trusted Publishing, with no static upload token on any publish path (`#3943`
closed this gap for `trueppm-api`; that release job is unproven until the next
`v*` tag, so `trueppm-api` versions through `0.4.0-beta.3` predate it and carry
no attestation). The images, the Helm chart, and the `trueppm-scheduler` /
`trueppm-mcp` packages also carry a CycloneDX SBOM; `trueppm-api` does not yet.
For the verification commands and a table of exactly where each artifact's
SBOM lives, see
[**Supply-chain verification**](https://docs.trueppm.com/administration/security/#supply-chain-verification)
in the docs.

## Acknowledgements

We gratefully acknowledge all responsible disclosures. A Hall of Fame will be maintained here once contributions are received.
