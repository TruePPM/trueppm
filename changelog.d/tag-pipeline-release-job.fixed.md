Fix tag-triggered CI pipeline and GitLab Releases: added `v*` tag rule to
`workflow:rules` (tag pipelines were silently suppressed), added the tag
case to `rules-website` so `website:build` runs and GitLab Pages deploys
on release tags, and added a `release:create` job that creates a GitLab
Release entry for every `v*` tag (pre-release builds get a short changelog
pointer; stable builds extract their CHANGELOG section).
