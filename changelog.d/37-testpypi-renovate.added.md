TestPyPI auto-publish for `trueppm-scheduler` on every `main` merge via a
new `scheduler:publish:test` CI job — versioned with a `.dev${CI_PIPELINE_IID}`
suffix for uniqueness. Renovate config at `renovate.json` manages weekly
dependency updates (Python, npm, Cargo, Docker, Helm, GitLab CI) with
grouped minor/patch PRs and auto-merge for devDependency patches.
Version, downloads, pipeline, and license badges added to README (#37).
