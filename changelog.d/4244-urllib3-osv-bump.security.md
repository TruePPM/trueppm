- **Dependency security bump**: `urllib3` 2.7.0 → 2.8.0 in `packages/api`
  (transitive via `boto3`/`botocore`, `docker`/`testcontainers`, and
  `requests`) clears two HIGH advisories: GHSA-8988-9cw3-xx77 (CVSS 7.6,
  HTTPS proxy TLS configuration may be ignored or overridden) and
  GHSA-vxq7-64xx-v4gw (CVSS 8.9, unbounded memory allocation reading a
  malicious chunked-encoding response). `urllib3` is not pinned directly in
  `packages/api/pyproject.toml`; this is a re-resolution against an
  already-present dependency, not a newly added package.
- **Dependency security bump**: `axios` 1.18.1 → 1.20.0 in `packages/web`
  clears seven HIGH advisories introduced by upstream releases since 1.18.1,
  including an HTTP/2 adapter that bypassed configured DNS lookup and proxy
  controls (GHSA-3pq3-5fj3-cg6v), a redirect-based SSRF via an unenforced
  `maxRedirects: 0` on the fetch adapter (GHSA-r4gj-5m52-g5wh), and a
  prototype-pollution gadget in the Node HTTP adapter allowing request
  socket hijack (GHSA-m8m8-qj5v-23w3). `axios` is already pinned `^1.18.1`
  in `packages/web/package.json`; 1.20.0 resolves within that existing
  range.
- **Dependency security bump**: `dompurify` 3.4.13 → 3.4.16 in both
  `packages/web` and `packages/website` clears GHSA-p98j-92pf-mc4p (LOW,
  CVSS 2.3 — non-blocking under `osv-severity-gate.sh`, fixed anyway since
  a patched release exists): an `IN_PLACE`-mode DOM XSS where a
  node-removing `afterSanitizeElements`/`afterSanitizeAttributes` hook
  could detach a subtree without neutralizing its descendants' event
  handlers, leaving them armed on the caller's live tree. `dompurify` is
  already pinned `^3.4.13` (web) and `^3.3.3` (website); 3.4.16 resolves
  within both existing ranges. The severity gate's table strips each
  finding's directory prefix down to the bare lockfile name, so both
  packages' identical `dompurify@3.4.13` findings displayed as the same
  "package-lock.json" row and read as one advisory rather than two — only
  bumping `packages/web` left the gate still WARNing on `packages/website`'s
  copy. No source in this repo calls `DOMPurify` with `IN_PLACE` or a
  node-removing hook, so the advisory had no reachable trigger here — fixed
  for defense in depth, not an active exposure.
