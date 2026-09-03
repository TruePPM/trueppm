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

## Acknowledgements

We gratefully acknowledge all responsible disclosures. A Hall of Fame will be maintained here once contributions are received.
