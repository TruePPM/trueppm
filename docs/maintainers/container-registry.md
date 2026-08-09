# Container Registry Cleanup Policy

This runbook covers the GitLab **container-registry cleanup policy** on
`trueppm/trueppm` and the nightly job that verifies released images are still
pullable. It is an internal project-maintenance runbook, not operator
documentation — self-hosters never perform these steps, so this page is kept in
`docs/` only and is **not** published to the public documentation site.

## Why this page exists

Every merge to `main` pushes a commit-SHA-tagged `api` and `web` image, so the
registry grows continuously and needs a cleanup policy. Release tags live in the
same registry and must **never** be swept.

On 2026-08-08 the policy ran for the first time configured as:

```
cadence:         1d
enabled:         true
keep_n:          1
older_than:      7d
name_regex:      .*
name_regex_keep: null
```

`name_regex: .*` matches every tag and `name_regex_keep: null` protects nothing,
so the sweep deleted `api:v0.3.0-alpha.3` and `web:v0.3.0-alpha.3` along with the
commit-SHA tags it was meant to reap (#2803). The 0.3 tag pipeline had succeeded
weeks earlier and is still green — nothing in CI reads the registry after a tag
ships, so the images simply stopped existing with no signal anywhere.

## The required policy

**`name_regex_keep` must protect release tags.** The current, correct
configuration is:

```
cadence:         1d
enabled:         true
keep_n:          10
older_than:      7d
name_regex:      .*
name_regex_keep: ^v.*$|^latest$
```

- `name_regex` (shown as `name_regex_delete` on write) selects candidates for
  deletion — everything.
- `name_regex_keep` overrides it — anything matching is never deleted. `^v.*$`
  covers every release tag including pre-releases (`v0.3.0-alpha.3`); `^latest$`
  keeps the rolling tag the Compose quickstart pulls.
- `keep_n: 10` retains the ten most recent commit-SHA images per repository, so a
  recent `main` build is always available to pull for debugging.

Read the live policy with:

```bash
glab api projects/trueppm%2Ftrueppm \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['container_expiration_policy'], indent=2))"
```

Write it back — note the API accepts `name_regex_delete` on write and reports it
as `name_regex` on read, and that the request needs an explicit JSON
content type:

```bash
cat > /tmp/policy.json <<'JSON'
{
  "container_expiration_policy_attributes": {
    "cadence": "1d",
    "enabled": true,
    "keep_n": 10,
    "older_than": "7d",
    "name_regex_delete": ".*",
    "name_regex_keep": "^v.*$|^latest$"
  }
}
JSON
glab api -X PUT projects/trueppm%2Ftrueppm \
  -H "Content-Type: application/json" --input /tmp/policy.json
```

The same settings are editable in the UI under **Settings → Packages and
registries → Clean up image tags**.

> **The policy is a project setting, not a file in this repo.** Nothing in the
> pipeline can prevent someone editing it in the UI, and a bad edit produces no
> diff, no review, and no failing job. That is what the nightly check below is
> for.

## The nightly guard: `registry:release-images`

`scripts/check-release-images.sh` resolves the newest `v*` tag from the
repository and probes the registry for both the `api` and `web` image at that
tag. It exits:

- `0` — every image is present;
- `1` — at least one is missing (the reaped-release case);
- `2` — invocation error: no `CI_REGISTRY_IMAGE`, or no `v*` tag to check. This
  is deliberately distinct from `1`, so a broken clone never reads as a deleted
  image.

The CI job `registry:release-images` runs it and is **not** `allow_failure`: an
operator who cannot pull the version we told them to run has no install, so this
must read red. It also runs on merge requests that touch the check itself,
because a green nightly proves nothing if the probe never worked.

### Scheduling it

The job is gated on `$CI_PIPELINE_SOURCE == "schedule" && $REGISTRY_NIGHTLY ==
"true"`, and the top-level `workflow:` rules only admit scheduled pipelines
carrying one of the known nightly variables. To run it, create a pipeline
schedule under **CI/CD → Schedules** on `main` with:

| Field | Value |
|---|---|
| Interval | daily (any time; nothing races it) |
| Target branch | `main` |
| Variable | `REGISTRY_NIGHTLY` = `true` |

Without that variable the schedule creates no pipeline at all, by design.

### When it fails

1. Confirm the tag really is gone — list the registry repositories and their
   tags via **Deploy → Container Registry**, or the API.
2. Check the cleanup policy against the required configuration above; if
   `name_regex_keep` is empty or wrong, fix it **first**, or the republish will
   be reaped again.
3. Republish by retrying the tag pipeline's publish jobs:

   ```bash
   # find the pipeline for the tag, then its publish jobs
   glab api "projects/trueppm%2Ftrueppm/pipelines/<pipeline_id>/jobs?per_page=100"
   glab api -X POST projects/trueppm%2Ftrueppm/jobs/<api_publish_job_id>/retry
   glab api -X POST projects/trueppm%2Ftrueppm/jobs/<web_publish_job_id>/retry
   ```

   If the jobs are too old to retry, create a fresh pipeline on the tag ref
   instead — its `api:publish` / `web:publish` jobs rebuild and re-push:

   ```bash
   glab api -X POST projects/trueppm%2Ftrueppm/pipeline -f ref=<tag>
   ```

Note that a republish rebuilds the image from the tagged source rather than
restoring the original bytes, so the digest changes. Anything pinned to the old
digest — a Cosign signature or an SBOM attestation on the GHCR copy — refers to
an image that no longer exists and must be re-signed by the same publish job.
