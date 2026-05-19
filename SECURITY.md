# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitLab issues.**

Report vulnerabilities privately by emailing **security@trueppm.com**.

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
| Patch release | Within 30 days for Critical/High; 90 days for Medium/Low |

We will credit reporters in the release notes unless anonymity is requested.

## Supported Versions

| Version | Security patches |
|---------|-----------------|
| `main` (unreleased) | ✅ Active |
| `0.1.x` (current alpha) | ✅ Active |
| < `0.1.0` | ❌ No support |

Once `1.0.0` is released, the two most recent minor versions will receive security backports.

## Disclosure Policy

TruePPM follows **coordinated disclosure**:

1. Reporter submits privately.
2. We confirm, investigate, and develop a fix.
3. We agree on a disclosure date — typically 90 days from report, sooner if a patch is ready.
4. We publish a GitLab Security Advisory and release a patch.
5. Reporter may publish their own write-up after the advisory is public.

## Scope

In scope: the TruePPM API (`packages/api`), web frontend (`packages/web`), scheduling engine (`packages/scheduler`), Helm chart (`packages/helm`), and the Docker Compose production stack.

Out of scope: the documentation website itself (`packages/website`), third-party dependencies (report those upstream), and findings that require physical access to the host.

## Acknowledgements

We gratefully acknowledge all responsible disclosures. A Hall of Fame will be maintained here once contributions are received.
