- **Docs version-status CI guard (#807)**: a new `docs:version-accuracy` pipeline
  job (`scripts/check-version-status.sh`) fails the build if any page under
  `packages/website/src/content/docs/` references an unshipped version in
  past/present tense. The roadmap's "## Shipped" section is the single source of
  truth; a shared `_release-status.mdx` snippet centralizes the shipped/alpha/
  underway version constants so banners derive from one place.
