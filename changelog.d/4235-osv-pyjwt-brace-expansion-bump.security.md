- **Dependency security bumps**: `pyjwt` 2.13.0 → 2.15.1 (`packages/api` and
  `packages/mcp`) clears one CRITICAL asymmetric-PEM detection bypass
  (GHSA-ffc3-869f-jxw9, CVSS 9.1) and five HIGH PyJWK/validation advisories.
  `brace-expansion` bumped at all three pinned major lines (1.1.18→1.1.21,
  2.1.4→2.1.7, 5.0.9→5.0.12 in `packages/web` and `packages/mobile`) clears a
  HIGH ReDoS/stack-exhaustion advisory (GHSA-6j4f-fj2g-mc7p /
  GHSA-qhr7-859c-m2p7). `fast-uri` 3.1.7 → 3.1.8 (`packages/website`) clears a
  MODERATE host-normalization advisory (GHSA-hrr3-gc8f-f4qj). All are unpatched
  pins against already-present dependencies, not newly added packages.
