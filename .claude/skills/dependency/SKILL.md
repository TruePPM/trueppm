---
name: dependency
model: sonnet
description: >
  Dependency audit for TruePPM before adding any new pip or npm package. Checks
  license compatibility (Apache 2.0 codebase), known CVEs, package health, and
  justification. The CI license-check job catches these too, but a failed license
  job is an avoidable interruption.
---

# Dependency Skill

You are auditing a new dependency before it is added to TruePPM.

## License Compatibility (Apache 2.0 codebase)

| License | Allowed in OSS | Allowed in Enterprise | Notes |
|---------|---------------|----------------------|-------|
| MIT | ✅ | ✅ | |
| Apache 2.0 | ✅ | ✅ | |
| BSD 2/3-clause | ✅ | ✅ | |
| ISC | ✅ | ✅ | |
| PSF | ✅ | ✅ | Python stdlib |
| LGPL v2/v3 | ⚠️ | ✅ | Dynamic linking only; no static linking |
| MPL 2.0 | ⚠️ | ✅ | File-level copyleft; acceptable with care |
| GPL v2/v3 | ❌ | ❌ | Copyleft — cannot ship in either edition |
| AGPL | ❌ | ❌ | Network copyleft — hard no |
| SSPL | ❌ | ❌ | MongoDB license — hard no |
| Proprietary | ❌ | ⚠️ | Enterprise only, with explicit approval |
| Unknown | ❌ | ❌ | Do not add until license is confirmed |

## Checklist

### Justification
- [ ] Is there an existing dependency in the project that already covers this use case?
  (Check `pyproject.toml` / `package.json` before adding anything new)
- [ ] Is this a core dependency or a dev-only dependency? (add to the right group)
- [ ] Is the package actively maintained? (last release < 12 months, open issues addressed)

### Security
- [ ] No known CVEs of severity HIGH or CRITICAL (check: `pip audit` / `npm audit`)
- [ ] Package has >1 maintainer or a reputable org behind it
- [ ] Package is not a typosquat of a popular package (verify the exact name)
- [ ] Pinned to a version range that allows patch updates but locks major version

### Size and Complexity
- [ ] The package does not pull in a large transitive dependency graph
- [ ] For frontend packages: check bundle size impact (`bundlephobia.com`)
- [ ] For backend packages: check import time impact on cold start

### Version Pinning Strategy
- Python: use `>=X.Y,<X+1` or `>=X.Y` with a known-good upper bound in lock file
- npm/pnpm: use `^X.Y.Z` with lock file committed
- Dev dependencies: can be more permissive (`>=X.Y`)

## Audit the Gate's Scope, Not Just Its Result

A green `security:osv` or `license:check` proves only that the manifests **in the scan list** are clean. This project's recurring dependency failure has never been a missed CVE — it has been a **manifest nobody was scanning**. An unscanned lockfile is worse than a known vulnerability, because nothing will ever tell you about it.

- [ ] **Enumerate every lockfile in the repo, then diff that list against what CI actually scans.** Run something like `find . -name 'uv.lock' -o -name 'package-lock.json' -o -name 'Cargo.lock' | grep -v node_modules` and compare it to the `-L` arguments in `security:osv` and the hardcoded paths in the `license:check:*` jobs. Any lockfile in the first list and not the second is a finding — report it with the same severity you would give a moderate CVE.
- [ ] **Weight a scope gap by whether the package is published.** A gap on an internal package is bad; a gap on a package that ships to PyPI or npm is a supply-chain hole in an artifact other people install.
- [ ] **When a new package is added to the monorepo, its lockfile joins the gates in the same MR.** New packages are exactly how these gaps appear — the scanner's path list is written once and never revisited.
- [ ] **Widening a scan usually requires widening the allow-list first.** Adding a previously-unscanned manifest will surface licenses the current `--onlyAllow` list does not name (e.g. an image or CSS toolchain pulling LGPL or MPL transitively). Check what the newly-covered manifests actually resolve to and stage the allow-list change ahead of the scope change, or the "fix" lands as a red pipeline.
- [ ] **A published package's declared version floor is part of its security surface.** The resolved version in *our* lockfile being patched does not help a downstream consumer who installs against our declared range. When a dependency has a known advisory, raise the **floor** in `pyproject.toml`/`package.json`, not just the lock.

## Output Format

```
## Dependency: <package-name> <version>

**License**: MIT / Apache 2.0 / etc.
**Verdict**: APPROVED / REJECTED / NEEDS REVIEW

### Justification
Why this package is needed and why no existing dependency covers it.

### Alternatives Considered
| Package | Reason not chosen |
|---------|------------------|
| ... | ... |

### Risks
- CVEs: none found / list any found
- Maintenance: last release X months ago, Y open issues
- Size: Xkb gzipped (frontend) / no significant impact (backend)

### Recommendation
Add to `[project.dependencies]` / `[project.optional-dependencies] dev` /
`devDependencies` / `dependencies` in <file>.
```
