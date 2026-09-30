- **Dependency security bump**: `urllib3` 2.7.0 → 2.8.0 in `packages/api`
  (transitive via `boto3`/`botocore`, `docker`/`testcontainers`, and
  `requests`) clears two HIGH advisories: GHSA-8988-9cw3-xx77 (CVSS 7.6,
  HTTPS proxy TLS configuration may be ignored or overridden) and
  GHSA-vxq7-64xx-v4gw (CVSS 8.9, unbounded memory allocation reading a
  malicious chunked-encoding response). `urllib3` is not pinned directly in
  `packages/api/pyproject.toml`; this is a re-resolution against an
  already-present dependency, not a newly added package.
